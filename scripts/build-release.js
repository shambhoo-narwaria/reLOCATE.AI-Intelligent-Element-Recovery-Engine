const fs = require('fs');
const path = require('path');

function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let entries = fs.readdirSync(src, { withFileTypes: true });

  for (let entry of entries) {
    let srcPath = path.join(src, entry.name);
    let destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Resolve paths relative to root directory
const rootDir = path.resolve(__dirname, '..');
const releaseDir = path.join(rootDir, 'out');

console.log('Cleaning old out folder...');
if (fs.existsSync(releaseDir)) {
  fs.rmSync(releaseDir, { recursive: true, force: true });
}
fs.mkdirSync(releaseDir);

// 1. Copy dist/
console.log('Copying dist/ directory...');
const distSrc = path.join(rootDir, 'dist');
if (!fs.existsSync(distSrc)) {
  console.error('[Error] dist directory does not exist. Run "npm run build" first.');
  process.exit(1);
}
copyDirSync(distSrc, path.join(releaseDir, 'dist'));

// 2. Copy Testcase/
console.log('Copying Testcase/ directory...');
copyDirSync(path.join(rootDir, 'Testcase'), path.join(releaseDir, 'Testcase'));

// 3. Copy config.json, package.json, package-lock.json
console.log('Copying configuration and package manifests...');
fs.copyFileSync(path.join(rootDir, 'config.json'), path.join(releaseDir, 'config.json'));
fs.copyFileSync(path.join(rootDir, 'package.json'), path.join(releaseDir, 'package.json'));
fs.copyFileSync(path.join(rootDir, 'package-lock.json'), path.join(releaseDir, 'package-lock.json'));

// 4. Create .env.example template
console.log('Generating .env.example template...');
const envContent = `OPENAI_API_KEY=your-openai-api-key-here
GEMINI_API_KEY=your-gemini-api-key-here
PORT=3000
AI_PROVIDER=gemini

# --- OpenRouter Config ---
OPENROUTER_API_KEY=your-openrouter-api-key-here
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_MODEL_NAME=openrouter/free

# --- EC2 Hosted Qwen 2.5 Config ---
# Change AI_PROVIDER to 'vllm' to enable this service
# VLLM_BASE_URL=http://<YOUR_EC2_IP>:8000/v1
# VLLM_MODEL_NAME=Qwen/Qwen2.5-14B-Instruct
# VLLM_API_KEY=dummy-key
`;
fs.writeFileSync(path.join(releaseDir, '.env.example'), envContent);

// 5. Write run.bat (Client Runner)
console.log('Writing run.bat...');
const runBatContent = `@echo off
echo ==========================================================
echo           reLOCATE.AI - Client Runner
echo ==========================================================
echo.

:: Check for Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in your PATH.
    echo Please install Node.js v18 or higher and try again.
    pause
    exit /b 1
)

:: Check for .env file
if not exist .env (
    echo [WARNING] .env file not found.
    echo Creating .env file from .env.example template.
    echo Please configure your API keys in the .env file and run this script again.
    copy .env.example .env
    pause
    exit /b 1
)

echo [1/2] Installing production dependencies and Playwright browsers...
call npm install --omit=dev
if %errorlevel% neq 0 (
    echo [ERROR] npm install failed.
    pause
    exit /b %errorlevel%
)

echo.
echo [2/2] Running the application...
call npm start

pause
`;
fs.writeFileSync(path.join(releaseDir, 'run.bat'), runBatContent);

// 6. Write run.sh (Client Runner)
console.log('Writing run.sh...');
const runShContent = `#!/bin/bash
echo "=========================================================="
echo "          reLOCATE.AI - Client Runner"
echo "=========================================================="
echo ""

# Check for Node.js
if ! command -v node &> /dev/null
then
    echo "[ERROR] Node.js is not installed or not in your PATH."
    echo "Please install Node.js (v18+) and try again."
    exit 1
fi

# Check for .env file
if [ ! -f .env ]; then
    echo "[WARNING] .env file not found."
    echo "Creating .env file from .env.example template."
    echo "Please configure your API keys in the .env file and run this script again."
    cp .env.example .env
    exit 1
fi

echo "[1/2] Installing production dependencies and Playwright browser binaries..."
npm install --omit=dev
if [ $? -ne 0 ]; then
    echo "[ERROR] npm install failed."
    exit 1
fi

echo ""
echo "[2/2] Running the application..."
npm start
`;
fs.writeFileSync(path.join(releaseDir, 'run.sh'), runShContent);

// 7. Write README.md
console.log('Writing README.md...');
const readmeContent = `# reLOCATE.AI Client Release

This directory contains the production-ready compiled release of the reLOCATE.AI element recovery system.

## Setup Instructions

1. **Install Node.js**: Ensure you have Node.js version 18 or above installed on your system.
2. **Setup Environment Variables**:
   - Copy or rename \`.env.example\` to \`.env\`.
   - Open \`.env\` and insert your AI Provider keys (e.g., \`GEMINI_API_KEY\`, \`OPENAI_API_KEY\`, or \`OPENROUTER_API_KEY\`).
   - Configure the \`AI_PROVIDER\` variable (e.g., \`gemini\` or \`openai\`).

## Running the Product

### On Windows
Double-click the \`run.bat\` file, or open a Command Prompt / PowerShell in this directory and execute:
\`\`\`cmd
run.bat
\`\`\`

### On Linux / macOS
Open a terminal in this directory and run:
\`\`\`bash
chmod +x run.sh
./run.sh
\`\`\`

---
*Note: The runner will automatically download the Chromium browser binary required by Playwright on its first execution.*
`;
fs.writeFileSync(path.join(releaseDir, 'README.md'), readmeContent);

console.log('Release package successfully built in "./out" directory!');
