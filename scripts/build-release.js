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

// Cache portable Node.js binaries
const { execSync } = require('child_process');
const binCacheDir = path.join(rootDir, 'bin_cache');

if (!fs.existsSync(binCacheDir)) {
  console.log('Downloading and extracting portable Node.js (Windows x64) to cache...');
  const nodeZipUrl = 'https://nodejs.org/dist/v18.20.4/node-v18.20.4-win-x64.zip';
  const tempZipPath = path.join(rootDir, 'node_temp.zip');
  const tempExtractPath = path.join(rootDir, 'node_temp_extracted');
  
  try {
    // Download using PowerShell
    execSync(`powershell -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '${nodeZipUrl}' -OutFile '${tempZipPath}'"`, { stdio: 'inherit' });
    
    // Extract using PowerShell
    if (fs.existsSync(tempExtractPath)) fs.rmSync(tempExtractPath, { recursive: true, force: true });
    execSync(`powershell -Command "Expand-Archive -Path '${tempZipPath}' -DestinationPath '${tempExtractPath}'"`, { stdio: 'inherit' });
    
    // Move extracted folder contents to bin_cache
    const extractedSubdir = path.join(tempExtractPath, 'node-v18.20.4-win-x64');
    copyDirSync(extractedSubdir, binCacheDir);
    
    // Clean up temp files
    fs.rmSync(tempZipPath, { force: true });
    fs.rmSync(tempExtractPath, { recursive: true, force: true });
    console.log('Portable Node.js cached successfully.');
  } catch (error) {
    console.error('Failed to set up portable Node.js cache:', error.message);
    process.exit(1);
  }
}

// Copy cached Node.js bin to release bin
console.log('Packaging portable Node.js binaries into release...');
copyDirSync(binCacheDir, path.join(releaseDir, 'bin'));

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
echo           reLOCATE.AI - Zero-Install Client Runner
echo ==========================================================
echo.

:: Check for .env file
if not exist .env (
    echo [WARNING] .env file not found.
    echo Creating .env file from .env.example template.
    echo Please configure your API keys in the .env file and run this script again.
    copy .env.example .env
    pause
    exit /b 1
)

echo [1/2] Preparing execution environment (this may take a minute on the first run)...
call .\\bin\\npm.cmd install --omit=dev --no-audit --no-fund --loglevel=error > nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Environment setup failed. Please check your internet connection and try again.
    pause
    exit /b %errorlevel%
)

echo.
echo [2/2] Running the application...
call .\\bin\\node.exe dist\\runner.js

pause
`;
fs.writeFileSync(path.join(releaseDir, 'run.bat'), runBatContent);

// 6. Write run.sh (Client Runner)
console.log('Writing run.sh...');
const runShContent = `#!/bin/bash
echo "=========================================================="
echo "          reLOCATE.AI - Zero-Install Client Runner"
echo "=========================================================="
echo ""

# Check for .env file
if [ ! -f .env ]; then
    echo "[WARNING] .env file not found."
    echo "Creating .env file from .env.example template."
    echo "Please configure your API keys in the .env file and run this script again."
    cp .env.example .env
    exit 1
fi

# Detect OS and architecture
OS_TYPE=$(uname -s)
ARCH_TYPE=$(uname -m)

LOCAL_BIN_DIR="./bin/node-portable"
LOCAL_NODE="$LOCAL_BIN_DIR/bin/node"
LOCAL_NPM="$LOCAL_BIN_DIR/bin/npm"

if [ ! -f "$LOCAL_NODE" ]; then
    # Fallback to global node if present
    if command -v node &> /dev/null; then
        NODE_EXEC="node"
        NPM_EXEC="npm"
    else
        echo "[1/2] Preparing execution environment (this may take a minute on the first run)..."
        
        # Determine Node.js download URL based on OS and architecture
        if [ "$OS_TYPE" = "Linux" ]; then
            if [ "$ARCH_TYPE" = "x86_64" ]; then
                NODE_URL="https://nodejs.org/dist/v18.20.4/node-v18.20.4-linux-x64.tar.xz"
            elif [ "$ARCH_TYPE" = "aarch64" ] || [ "$ARCH_TYPE" = "arm64" ]; then
                NODE_URL="https://nodejs.org/dist/v18.20.4/node-v18.20.4-linux-arm64.tar.xz"
            fi
        elif [ "$OS_TYPE" = "Darwin" ]; then
            if [ "$ARCH_TYPE" = "x86_64" ]; then
                NODE_URL="https://nodejs.org/dist/v18.20.4/node-v18.20.4-darwin-x64.tar.gz"
            elif [ "$ARCH_TYPE" = "arm64" ]; then
                NODE_URL="https://nodejs.org/dist/v18.20.4/node-v18.20.4-darwin-arm64.tar.gz"
            fi
        fi

        if [ -z "$NODE_URL" ]; then
            echo "[ERROR] Unsupported platform: $OS_TYPE $ARCH_TYPE. Please install Node.js (v18+) manually."
            exit 1
        fi

        # Download and extract Node.js
        mkdir -p "$LOCAL_BIN_DIR"
        TEMP_ARCHIVE="node_temp_archive"
        
        if command -v curl &> /dev/null; then
            curl -sL "$NODE_URL" -o "$TEMP_ARCHIVE"
        elif command -v wget &> /dev/null; then
            wget -qO "$TEMP_ARCHIVE" "$NODE_URL"
        else
            echo "[ERROR] Neither curl nor wget is installed. Please install curl or wget, or install Node.js manually."
            exit 1
        fi

        if [[ "$NODE_URL" == *.tar.xz ]]; then
            tar -xJf "$TEMP_ARCHIVE" -C "$LOCAL_BIN_DIR" --strip-components=1
        else
            tar -xzf "$TEMP_ARCHIVE" -C "$LOCAL_BIN_DIR" --strip-components=1
        fi
        
        rm "$TEMP_ARCHIVE"
        NODE_EXEC="$LOCAL_NODE"
        NPM_EXEC="$LOCAL_NPM"
    fi
else
    NODE_EXEC="$LOCAL_NODE"
    NPM_EXEC="$LOCAL_NPM"
fi

# Ensure executable permissions on local node if we are using it
if [ "$NODE_EXEC" = "$LOCAL_NODE" ]; then
    chmod +x "$LOCAL_NODE"
    chmod +x "$LOCAL_NPM"
fi

# Install production dependencies silently
echo "[1/2] Preparing execution environment (this may take a minute on the first run)..."
"$NPM_EXEC" install --omit=dev --no-audit --no-fund --loglevel=error > /dev/null 2>&1
if [ $? -ne 0 ]; then
    echo "[ERROR] Environment setup failed. Please check your internet connection."
    exit 1
fi

echo ""
echo "[2/2] Running the application..."
"$NODE_EXEC" dist/runner.js
`;
fs.writeFileSync(path.join(releaseDir, 'run.sh'), runShContent);

// 7. Write README.md
console.log('Writing README.md...');
const readmeContent = `# reLOCATE.AI - Client Release

This directory contains the production release package of the reLOCATE.AI element recovery engine.

## Setup Instructions

1. **Configure Environment**:
   - Copy or rename \`.env.example\` to \`.env\` in this directory.
   - Open \`.env\` in any text editor and fill in your API credentials (e.g., \`GEMINI_API_KEY\`, \`OPENAI_API_KEY\`, etc.) and set your preferred \`AI_PROVIDER\`.

2. **Execution**:
   - **On Windows**: Simply double-click the \`run.bat\` file to start.
   - **On Linux / macOS**: Run the \`run.sh\` script in your terminal:
     \`\`\`bash
     chmod +x run.sh
     ./run.sh
     \`\`\`
`;
fs.writeFileSync(path.join(releaseDir, 'README.md'), readmeContent);

console.log('Release package successfully built in "./out" directory!');
