#!/bin/bash
echo "=========================================================="
echo "          reLOCATE.AI - Automated Installer and Runner"
echo "=========================================================="
echo ""

# Check for Node.js
if ! command -v node &> /dev/null
then
    echo "[ERROR] Node.js is not installed or not in your PATH."
    echo "Please install Node.js (v18+) and try again."
    exit 1
fi

echo "[1/3] Installing dependencies and Playwright browser binaries..."
npm install
if [ $? -ne 0 ]; then
    echo "[ERROR] npm install failed."
    exit 1
fi

echo ""
echo "[2/3] Building TypeScript files to production JavaScript..."
npm run build
if [ $? -ne 0 ]; then
    echo "[ERROR] Build failed."
    exit 1
fi

echo ""
echo "[3/3] Running the application..."
npm start
