@echo off
REM === Vault Dashboard GitHub Pages デプロイスクリプト ===
REM PowerShellから実行: .\deploy_pages.ps1
REM またはダブルクリックで実行

echo 🚀 Vault Dashboard を GitHub Pages にデプロイ中...

cd /d "C:\Users\swamp\.gemini\antigravity\scratch\vault-dashboard"

REM Git 初期化（既に .git がある場合はスキップ）
git add -A
git commit -m "deploy: Vault Dashboard v3.1 for GitHub Pages"
git remote set-url origin https://github.com/abscly/vault-dashboard.git 2>nul || git remote add origin https://github.com/abscly/vault-dashboard.git
git push -u origin main --force

echo.
echo ✅ Push 完了！
echo 📝 次のステップ: GitHub でPages を有効にしてね
echo    https://github.com/abscly/vault-dashboard/settings/pages
echo    Source: main branch / root
echo.
pause
