// scripts/exportContext.js
const fs = require('fs');
const path = require('path');

// --- Configuration ---
const outputFileName = 'contextExport.txt';
const srcDir = 'src';
const rootFilesToInclude = [
  'package.json',
  'README.md',
  'Dockerfile',
  'docker-compose.yml',
  'start.sh'
];
const baseExcludedDirs = ['node_modules', 'dist', '.git', 'scripts']; // Directories to always exclude
const optionalDirs = ['commands', 'events']; // Directories to potentially include/exclude

// --- Helper Functions ---

/**
 * Recursively gets all relevant file paths within a directory.
 * @param {string} dirPath The directory path to scan.
 * @param {string[]} currentExcludedDirs The list of directories to exclude.
 * @param {string[]} fileList Accumulator for file paths.
 * @returns {string[]} An array of full file paths.
 */
function getAllFilesRecursive(dirPath, currentExcludedDirs, fileList = []) {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        if (currentExcludedDirs.includes(entry.name)) {
          continue; // Skip excluded directories
        }
        getAllFilesRecursive(fullPath, currentExcludedDirs, fileList); // Recurse
      } else if (entry.isFile()) {
        // Only include specific file types relevant to context
        if (fullPath.endsWith('.ts') || fullPath.endsWith('.js') || fullPath.endsWith('.json')) {
          // Check if the path contains any excluded directory segment
          const pathSegments = fullPath.split(path.sep);
          if (!pathSegments.some(segment => currentExcludedDirs.includes(segment))) {
            fileList.push(fullPath);
          }
        }
      }
    }
  } catch (error) {
    console.warn(`Warning: Could not read directory ${dirPath}. Skipping. Error: ${error.message}`);
  }
  return fileList;
}

/**
 * Recursively finds empty directories within a path, respecting exclusions.
 * @param {string} dirPath The directory path to scan.
 * @param {string[]} currentExcludedDirs The list of directories to exclude.
 * @param {string[]} emptyDirsList Accumulator for empty directory paths.
 * @returns {string[]} An array of full paths to empty directories.
 */
function findEmptyDirsRecursive(dirPath, currentExcludedDirs, emptyDirsList = []) {
  try {
    let isEmpty = true;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);

      if (entry.isDirectory()) {
        if (currentExcludedDirs.includes(entry.name)) {
          continue; // Skip excluded directories
        }
        // If we find a non-excluded subdirectory, the current one isn't empty *yet*
        isEmpty = false;
        findEmptyDirsRecursive(fullPath, currentExcludedDirs, emptyDirsList); // Recurse
      } else if (entry.isFile()) {
        // If we find any file, it's not empty
        isEmpty = false;
      }
    }

    // If, after checking all entries, it's still considered empty, add it
    if (isEmpty) {
      emptyDirsList.push(dirPath);
    }
  } catch (error) {
    console.warn(`Warning: Could not read directory ${dirPath} for empty check. Skipping. Error: ${error.message}`);
  }
  return emptyDirsList;
}


/**
 * Reads the content of a file safely.
 * @param {string} filePath The path to the file.
 * @returns {string | null} The file content or null if reading fails.
 */
function readFileContent(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    } else {
      console.warn(`Warning: File not found: ${filePath}. Skipping.`);
      return null;
    }
  } catch (error) {
    console.error(`Error reading file ${filePath}:`, error);
    return null;
  }
}

// --- Main Script Logic ---

async function exportContext() {
  console.log('Starting context export...');

  // Determine if optional directories should be included
  // Use slice(2) to get arguments passed after "node script.js"
  const args = process.argv.slice(2);
  const includeOptional = args.includes('--all');
  console.log(`Arguments received: [${args.join(', ')}]`);
  console.log(`Including optional directories ('${optionalDirs.join(', ')}'): ${includeOptional}`);

  let outputContent = '';
  const projectRoot = path.resolve(__dirname, '..'); // Go up one level from scripts/

  // 1. Add App Description from package.json
  const packageJsonPath = path.join(projectRoot, 'package.json');
  const packageJsonContent = readFileContent(packageJsonPath);
  if (packageJsonContent) {
    try {
      const packageData = JSON.parse(packageJsonContent);
      outputContent += `App Description: ${packageData.description || 'No description found.'}\n\n`;
    } catch (e) {
      console.error("Error parsing package.json:", e);
      outputContent += "App Description: Error parsing package.json\n\n";
    }
  } else {
    outputContent += "App Description: package.json not found.\n\n";
  }


  // 2. Process Root Files
  console.log('Processing root files...');
  for (const fileName of rootFilesToInclude) {
    const filePath = path.join(projectRoot, fileName);
    const content = readFileContent(filePath);
    if (content !== null) {
      const relativePath = path.relative(projectRoot, filePath);
      const posixPath = relativePath.split(path.sep).join(path.posix.sep);
      outputContent += `${posixPath}:\n${content}\n\n`;
      console.log(`  Added File: ${posixPath}`);
    }
  }

  // 3. Process 'src' Directory Files
  console.log(`Processing '${srcDir}' directory files...`);
  const srcPath = path.join(projectRoot, srcDir);
  let currentExcluded = [...baseExcludedDirs]; // Start with base exclusions
  if (!includeOptional) {
    currentExcluded = currentExcluded.concat(optionalDirs);
  }
  console.log(`Effective excluded directories: [${currentExcluded.join(', ')}]`);

  const srcFiles = getAllFilesRecursive(srcPath, currentExcluded);

  for (const filePath of srcFiles) {
    const content = readFileContent(filePath);
    if (content !== null) {
      const relativePath = path.relative(projectRoot, filePath);
      const posixPath = relativePath.split(path.sep).join(path.posix.sep);
      outputContent += `${posixPath}:\n${content}\n\n`;
      console.log(`  Added File: ${posixPath}`);
    }
  }

  // 4. Find and Add Empty Directories within 'src'
  console.log(`Processing '${srcDir}' for empty directories...`);
  const emptyDirs = findEmptyDirsRecursive(srcPath, currentExcluded);

  for (const dirPath of emptyDirs) {
    // Skip adding the base srcPath itself if it happens to be empty
    if (path.normalize(dirPath) === path.normalize(srcPath)) continue;

    const relativePath = path.relative(projectRoot, dirPath);
    const posixPath = relativePath.split(path.sep).join(path.posix.sep);
    outputContent += `${posixPath}/ (empty)\n\n`; // Add trailing slash and marker
    console.log(`  Added Empty Dir: ${posixPath}/`);
  }


  // 5. Write to Output File
  const outputFilePath = path.join(projectRoot, outputFileName);
  try {
    fs.writeFileSync(outputFilePath, outputContent.trimEnd(), 'utf-8');
    console.log(`\nContext successfully exported to: ${outputFilePath}`);
  } catch (error) {
    console.error(`\nError writing output file ${outputFileName}:`, error);
  }
}

// --- Run the script ---
exportContext();

