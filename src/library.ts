import fs from 'fs';
import path from 'path';
import Papa from 'papaparse';
import { GoogleGenerativeAI, Part } from '@google/generative-ai';
import { GoogleAIFileManager } from '@google/generative-ai/server';
import { app } from 'electron';
import sizeOf from 'image-size';
import ffmpeg from 'fluent-ffmpeg';
// @ts-ignore
import ffprobeStatic from 'ffprobe-static';

ffmpeg.setFfprobePath(ffprobeStatic.path);

const getVideoDims = (filePath: string): Promise<{ width: number, height: number }> => {
    return new Promise((resolve) => {
        ffmpeg.ffprobe(filePath, (err: any, metadata: any) => {
            if (err) return resolve({ width: 0, height: 0 });
            const stream = metadata?.streams?.find((s: any) => s.codec_type === 'video');
            if (stream) {
                // Handle rotation if present
                let w = stream.width || 0;
                let h = stream.height || 0;
                if (stream.tags && stream.tags.rotate) {
                    const rot = Math.abs(parseInt(stream.tags.rotate));
                    if (rot === 90 || rot === 270) {
                        w = stream.height || 0;
                        h = stream.width || 0;
                    }
                }
                resolve({ width: w, height: h });
            }
            else resolve({ width: 0, height: 0 });
        });
    });
};

const getAspectRatioLabel = (width: number, height: number): string => {
    if (width === 0 || height === 0) return 'otro';
    const ratioValue = width / height;
    if (Math.abs(ratioValue - 1) < 0.05) return '1:1';
    if (Math.abs(ratioValue - 4 / 3) < 0.05) return '4:3';
    if (Math.abs(ratioValue - 16 / 9) < 0.05) return '16:9';
    if (Math.abs(ratioValue - 9 / 16) < 0.05) return '9:16';
    if (Math.abs(ratioValue - 3 / 2) < 0.05) return '3:2';
    if (Math.abs(ratioValue - 2 / 3) < 0.05) return '2:3';

    // Fallback to GCD simplified ratio
    const gcd = (a: number, b: number): number => b === 0 ? a : gcd(b, a % b);
    const divisor = gcd(width, height);
    return (width && height && divisor) ? `${width / divisor}:${height / divisor}` : 'otro';
};

const getResolutionLabel = (width: number, height: number): string => {
    const maxDim = Math.max(width, height);
    if (maxDim === 0) return 'SD';
    if (maxDim > 2560) return '4K';
    if (maxDim > 1920) return '2K';
    if (maxDim > 1280) return 'FHD';
    if (maxDim > 720) return 'HD';
    return 'SD';
};

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

const MEDIA_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4', '.mov', '.avi', '.webm'];

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
                if (MEDIA_EXTENSIONS.includes(path.extname(fullPath).toLowerCase())) {
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
        const images: Partial<PhotoMetadata>[] = [];
        for (const fullPath of imagePaths) {
            const stats = fs.statSync(fullPath);
            const ext = path.extname(fullPath).toLowerCase();
            const isVideo = ['.mp4', '.mov', '.avi', '.webm'].includes(ext);
            const filename = path.basename(fullPath);

            // Smart skipping: if metadata exists and file hasn't changed, reuse technical data
            const existing = existingMetadata[fullPath];
            const dateTaken = stats.birthtimeMs > 0 ? stats.birthtime.toISOString() : stats.mtime.toISOString();

            let width = 0;
            let height = 0;
            let resolution = 'SD';
            let aspectRatio = 'otro';

            const fileSizeKb = Math.round(stats.size / 1024);
            const fileHasChanged = existing ? (existing.file_size_kb !== fileSizeKb) : true;

            if (existing && !fileHasChanged && existing.width && existing.height) {
                // Reuse existing technical data
                width = existing.width;
                height = existing.height;
                resolution = existing.resolution || getResolutionLabel(width, height);
                aspectRatio = existing.aspect_ratio || getAspectRatioLabel(width, height);
            } else {
                // Re-calculate or first time
                try {
                    if (!isVideo) {
                        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                        // @ts-ignore
                        const dimensions = sizeOf(fullPath);
                        width = dimensions.width || 0;
                        height = dimensions.height || 0;
                    } else {
                        const dims = await getVideoDims(fullPath);
                        width = dims.width;
                        height = dims.height;
                    }
                } catch (e: any) {
                    console.warn("Could not read media size for", fullPath, e.message);
                }
                aspectRatio = getAspectRatioLabel(width, height);
                resolution = getResolutionLabel(width, height);
            }

            const basicData = {
                filename,
                path: fullPath,
                file_size_kb: fileSizeKb,
                format: ext.replace('.', ''),
                date_taken: dateTaken,
                width,
                height,
                resolution,
                aspect_ratio: aspectRatio,
            };

            if (existing) {
                images.push({
                    ...existing,
                    ...basicData,
                });
            } else {
                images.push({
                    ...basicData,
                    orientation: width > height ? 'horizontal' : 'vertical' as any,
                    has_text: false,
                    tags: []
                });
            }
        }

        return { success: true, count: images.length, images };
    } catch (error) {
        console.error("Scan error:", error);
        return { success: false, error: "Error al escanear el directorio." };
    }
}

export async function analyzeImageHandler(filePath: string, customPrompt?: string, apiKey?: string) {
    try {
        if (!apiKey) {
            return { success: false, error: "API Key no configurada" };
        }

        if (!fs.existsSync(filePath)) {
            return { success: false, error: "Archivo no encontrado" };
        }

        const ext = path.extname(filePath).toLowerCase();
        const isVideo = ['.mp4', '.mov', '.avi', '.webm'].includes(ext);

        let mimeType = 'image/jpeg';
        if (ext === '.png') mimeType = 'image/png';
        if (ext === '.webp') mimeType = 'image/webp';
        if (ext === '.gif') mimeType = 'image/gif';
        if (ext === '.mp4') mimeType = 'video/mp4';
        if (ext === '.mov') mimeType = 'video/quicktime';
        if (ext === '.avi') mimeType = 'video/x-msvideo';
        if (ext === '.webm') mimeType = 'video/webm';

        const stats = fs.statSync(filePath);
        const file_size_kb = Math.round(stats.size / 1024);
        let width = 0;
        let height = 0;

        if (isVideo) {
            const dims = await getVideoDims(filePath);
            width = dims.width;
            height = dims.height;
        } else {
            try {
                // Optimized: sizeOf(path) instead of buffer
                // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                // @ts-ignore
                const dims = sizeOf(filePath);
                width = dims.width || 0;
                height = dims.height || 0;
            } catch (e) {
                console.error("Error reading image size:", e);
            }
        }

        // Calculate technical resolution and aspect ratio using shared helpers
        const techAspectRatio = getAspectRatioLabel(width, height);
        const techResolution = getResolutionLabel(width, height);

        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" }, { apiVersion: 'v1beta' });
        const parts: Part[] = [];

        if (isVideo) {
            // Upload to Google AI File Manager
            const fileManager = new GoogleAIFileManager(apiKey);
            const uploadResult = await fileManager.uploadFile(filePath, {
                mimeType,
                displayName: path.basename(filePath),
            });

            // Wait for video processing
            let fileInfo = await fileManager.getFile(uploadResult.file.name);
            let attempts = 0;
            while (fileInfo.state === 'PROCESSING' && attempts < 60) {
                await new Promise(r => setTimeout(r, 2000));
                fileInfo = await fileManager.getFile(uploadResult.file.name);
                attempts++;
            }
            if (fileInfo.state === 'FAILED') {
                return { success: false, error: "Error procesando el video en Google AI" };
            }

            parts.push({
                fileData: {
                    fileUri: uploadResult.file.uri,
                    mimeType
                } as any
            });
        } else {
            const fileBuffer = fs.readFileSync(filePath);
            const base64Image = fileBuffer.toString('base64');
            parts.push({
                inlineData: {
                    data: base64Image,
                    mimeType
                }
            });
        }

        parts.push({
            text: customPrompt || `
                Analiza este contenido multimedia (imagen o video) y describe detalladamente su contenido en español.
                Devuelve un objeto JSON con los siguientes campos (string a menos que se indique lo contrario). IMPORTANTE: Todos los campos excepto 'description' y 'tags' DEBEN contener como MÁXIMO 4 palabras.
                - description: Una descripción detallada (2-3 oraciones).
                - style: Estilo fotográfico o artístico (ej. retrato, documental, urbano, deportivo). Máx 4 palabras.
                - lighting: Tipo de iluminación (ej. luz natural, luz artificial, cálida). Máx 4 palabras.
                - scene_type: (ej. interior, exterior, estudio, abstracto). Máx 4 palabras.
                - setting: El entorno o contexto (ej. urbano, naturaleza, playa, oficina). Máx 4 palabras.
                - color_palette: Tonos dominantes. Máx 4 palabras.
                - mood: Sensación o atmósfera. Máx 4 palabras.
                - main_subject: Quién o qué es el sujeto principal. Máx 4 palabras.
                - action: Acción principal en infinitivo o gerundio (ej. caminando, posando). Máx 4 palabras.
                - tags: Array de strings con 5 a 10 etiquetas clave.
                - has_text: (Booleano) ¿Contiene texto legible importante?
                - text_content: Si has_text es true, el texto detectado (string), si no, vacío.
                - resolution: Solo para videos si la detectas (ej. HD, FHD, 4K, SD). Máx 4 palabras.
                - aspect_ratio: Relación de aspecto detectada (ej. 16:9, 4:3, 1:1, 9:16, 2:3, 3:2, otro). Máx 4 palabras.
                - date_taken: Si es posible, detecta la fecha en que se tomó la foto o video (YYYY-MM-DD). Máx 4 palabras.
            `
        });

        const result = await model.generateContent({
            contents: [{ role: "user", parts }],
        });
        const response = result.response;
        let text = response.text().trim();

        // Helper to extract JSON if Gemini wraps it in markdown code blocks
        if (text.includes('```')) {
            const matches = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (matches && matches[1]) {
                text = matches[1].trim();
            }
        }

        try {
            const parsed = JSON.parse(text);
            const mergedData = {
                ...parsed,
                width,
                height,
                file_size_kb,
                format: ext.substring(1).toUpperCase(),
                resolution: parsed.resolution || techResolution,
                aspect_ratio: parsed.aspect_ratio || techAspectRatio,
                date_taken: parsed.date_taken || (stats.birthtimeMs > 0 ? stats.birthtime.toISOString() : stats.mtime.toISOString())
            };
            console.log(`[GEMINI] Analysis successful for ${path.basename(filePath)}`);
            return { success: true, data: mergedData };
        } catch (e) {
            console.error("[GEMINI] Parsing failed for response:", text);
            return { success: false, error: "Error parseando la respuesta de la IA" };
        }
    } catch (error: any) {
        console.error('Gemini API Error:', error);
        return { success: false, error: error.message || "Error al conectar con Gemini" };
    }
}
