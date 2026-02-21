import fs from 'fs';
import path from 'path';
import Papa from 'papaparse';
import { GoogleGenerativeAI, Part } from '@google/generative-ai';
import { app } from 'electron';
import sizeOf from 'image-size';

export interface PhotoMetadata {
    filename: string;
    path: string;
    format: string;
    width: number;
    height: number;
    resolution: string;
    aspect_ratio: string;
    orientation: 'horizontal' | 'vertical' | 'square';
    file_size_kb: number;
    description: string;
    scene_type: string;
    setting: string;
    lighting: string;
    color_palette: string;
    style: string;
    mood: string;
    has_text: boolean;
    text_content: string;
    main_subject: string;
    action: string;
    tags: string[];
    date_added?: string;
    date_taken?: string;
    realPath?: string;
}

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

export function parseCSV(csvContent: string): Promise<Partial<PhotoMetadata>[]> {
    return new Promise((resolve, reject) => {
        Papa.parse(csvContent, {
            header: true,
            skipEmptyLines: true,
            complete: (results: any) => {
                const data = results.data.map((row: any) => ({
                    ...row,
                    tags: row.tags ? row.tags.split(',').map((t: string) => t.trim()).filter(Boolean) : [],
                    has_text: row.has_text === 'true',
                    width: row.width ? parseInt(row.width) : 0,
                    height: row.height ? parseInt(row.height) : 0,
                    file_size_kb: row.file_size_kb ? parseInt(row.file_size_kb) : 0,
                }));
                resolve(data);
            },
            error: (error: any) => reject(error),
        });
    });
}

export function generateCSV(data: Partial<PhotoMetadata>[]): string {
    const csvData = data.map(row => ({
        ...row,
        tags: row.tags ? row.tags.join(', ') : '',
        has_text: row.has_text ? 'true' : 'false',
    }));
    return Papa.unparse(csvData);
}

function scanDirRecursive(dirPath: string, fileList: string[] = []) {
    try {
        const files = fs.readdirSync(dirPath);
        files.forEach((file) => {
            const fullPath = path.join(dirPath, file);
            if (fs.statSync(fullPath).isDirectory()) {
                scanDirRecursive(fullPath, fileList);
            } else {
                if (IMAGE_EXTENSIONS.includes(path.extname(fullPath).toLowerCase())) {
                    fileList.push(fullPath);
                }
            }
        });
    } catch (err) {
        console.error(`Skipping directory ${dirPath}:`, err);
    }
    return fileList;
}

export async function scanDirectoryHandler(dirPath: string) {
    try {
        if (!fs.existsSync(dirPath)) {
            return { success: false, error: `Directorio no encontrado: ${dirPath}` };
        }

        const stats = fs.statSync(dirPath);
        if (!stats.isDirectory()) {
            return { success: false, error: `La ruta no es un directorio: ${dirPath}` };
        }

        const csvPath = path.join(dirPath, 'photos.csv');
        const existingMetadata: Record<string, Partial<PhotoMetadata>> = {};

        if (fs.existsSync(csvPath)) {
            try {
                const csvContent = fs.readFileSync(csvPath, 'utf-8');
                const parsed = await parseCSV(csvContent);
                parsed.forEach(p => {
                    if (p.path) existingMetadata[p.path] = p;
                });
            } catch (err) {
                console.warn("Could not read existing CSV:", err);
            }
        }

        const imagePaths = scanDirRecursive(dirPath);
        const images: Partial<PhotoMetadata>[] = imagePaths.map(fullPath => {
            const stats = fs.statSync(fullPath);
            let width = 0;
            let height = 0;
            try {
                const buffer = fs.readFileSync(fullPath);
                // @ts-ignore
                const dimensions = sizeOf(buffer);
                width = dimensions.width || 0;
                height = dimensions.height || 0;
            } catch (e: any) {
                console.warn("Could not read image size for", fullPath, e.message);
            }

            const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
            const divisor = gcd(width, height);
            const aspectRatio = (width && height && divisor) ? `${width / divisor}:${height / divisor}` : '';

            // Fallback to mtime if birthtime is 0
            const dateTaken = stats.birthtimeMs > 0 ? stats.birthtime.toISOString() : stats.mtime.toISOString();

            const basicData = {
                filename: path.basename(fullPath),
                path: fullPath,
                file_size_kb: Math.round(stats.size / 1024),
                format: path.extname(fullPath).replace('.', ''),
                date_taken: dateTaken,
                width,
                height,
                resolution: width && height ? `${width} x ${height}` : '',
                aspect_ratio: aspectRatio,
            };

            if (existingMetadata[fullPath]) {
                return {
                    ...existingMetadata[fullPath],
                    ...basicData,
                };
            }

            return {
                ...basicData,
                orientation: 'horizontal',
                has_text: false,
                tags: []
            };
        });

        return { success: true, count: images.length, images };
    } catch (error) {
        console.error("Scan error:", error);
        return { success: false, error: "Error al escanear el directorio." };
    }
}

export async function analyzeImageHandler(base64Image: string, mimeType: string, customPrompt?: string, apiKey?: string) {
    try {
        if (!apiKey) {
            return { success: false, error: "API Key no configurada" };
        }

        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        const parts: Part[] = [
            {
                inlineData: {
                    data: base64Image,
                    mimeType
                }
            },
            {
                text: customPrompt || `
                    Analiza esta imagen y describe detalladamente su contenido en español.
                    Devuelve un objeto JSON con los siguientes campos (string a menos que se indique lo contrario). IMPORTANTE: Todos los campos excepto 'description' y 'tags' DEBEN contener como MÁXIMO 1 o 2 palabras. Sé muy conciso.
                    - description: Una descripción detallada (2-3 oraciones).
                    - style: Estilo fotográfico o artístico (ej. retrato, documental, urbano, foto macro, foto deportiva). Máx 2 palabras.
                    - lighting: Tipo de iluminación (ej. luz natural, atardecer, luz artificial, flash). Máx 2 palabras.
                    - scene_type: (ej. interior, exterior, callejero, naturaleza). Máx 2 palabras.
                    - setting: El entorno o contexto (ej. evento deportivo, estudio fotográfico, parque público). Máx 2 palabras.
                    - color_palette: Tonos dominantes. Máx 2 palabras.
                    - mood: Sensación o atmósfera. Máx 2 palabras.
                    - main_subject: Quién o qué es el sujeto principal (ej. deportista, edificio moderno). Máx 2 palabras.
                    - action: Acción principal en infinitivo o gerundio (ej. corriendo, posando, estático). Máx 2 palabras.
                    - tags: Array de strings con 5 a 10 etiquetas clave.
                    - has_text: (Booleano) ¿Contiene texto legible importante?
                    - text_content: Si has_text es true, el texto detectado (string), si no, vacío.
                `
            }
        ];

        const result = await model.generateContent({
            contents: [{ role: "user", parts }],
            generationConfig: {
                responseMimeType: "application/json",
            }
        });
        const response = result.response;
        let text = response.text();

        // Use a simple prompt cleansing to ensure valid JSON is returned
        text = text.trim();

        try {
            const parsed = JSON.parse(text);
            return { success: true, data: parsed };
        } catch (e) {
            console.error("Parsing Gemini response failed:", text);
            return { success: false, error: "Error parseando la respuesta de la IA" };
        }
    } catch (error: any) {
        console.error('Gemini API Error:', error);
        return { success: false, error: error.message || "Error al conectar con Gemini" };
    }
}
