import * as fs from 'fs';
import * as path from 'path';

/**
 * Gets all files or folders directly within a given directory (non-recursive for files).
 * @param directory The directory path to scan.
 * @param foldersOnly If true, returns only immediate sub-directory paths.
 * If false, returns only immediate file paths matching .ts or .js. Defaults to false.
 * @returns An array of full paths.
 */
export default function getAllFiles(directory: string, foldersOnly = false): string[] {
  let fileNames: string[] = [];
  try {
    const entries = fs.readdirSync(directory, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (foldersOnly) {
        // Return only immediate directories
        if (entry.isDirectory()) {
          fileNames.push(entryPath);
        }
      } else {
        // Return only immediate files with specific extensions
        if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
          fileNames.push(entryPath);
        }
      }
    }
  } catch (error) {
     console.warn(`[getAllFiles] Could not read directory ${directory}. Error: ${(error as Error).message}`);
     // Return empty array on error to prevent downstream issues
     return [];
  }
  return fileNames;
}
