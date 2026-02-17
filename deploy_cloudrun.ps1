# Vault Dashboard — Cloud Run デプロイ
# 使い方: .\deploy_cloudrun.ps1
#
# 前提条件:
#   - gcloud CLI がインストール済み
#   - gcloud auth login 済み
#   - Docker Desktop がインストール済み（ローカルビルド時）

$PROJECT_ID = "stella-462710"
$REGION = "asia-northeast1"
$SERVICE_NAME = "vault-dashboard"
$IMAGE_NAME = "gcr.io/$PROJECT_ID/$SERVICE_NAME"

# gcloud PATH 自動検出
$gcloudPath = "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin"
if (Test-Path $gcloudPath) {
    $env:PATH = "$gcloudPath;$env:PATH"
}
if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
    Write-Host '  ❌ gcloud CLI が見つかりません' -ForegroundColor Red
    Write-Host '    → https://cloud.google.com/sdk/docs/install' -ForegroundColor DarkGray
    exit 1
}

Write-Host '=================================================='
Write-Host '  Vault Dashboard → Cloud Run Deploy' -ForegroundColor Cyan
Write-Host '=================================================='

# 1. Cloud Build でビルド + push（Docker不要）
Write-Host ''
Write-Host '  [1/3] Building with Cloud Build...' -ForegroundColor Yellow
gcloud builds submit --tag $IMAGE_NAME --project $PROJECT_ID

# 2. Cloud Run にデプロイ
Write-Host ''
Write-Host '  [2/3] Deploying to Cloud Run...' -ForegroundColor Yellow
gcloud run deploy $SERVICE_NAME `
    --image $IMAGE_NAME `
    --region $REGION `
    --project $PROJECT_ID `
    --platform managed `
    --allow-unauthenticated `
    --port 8080 `
    --memory 128Mi `
    --cpu 1 `
    --min-instances 0 `
    --max-instances 2 `
    --concurrency 80

# 3. URL取得
Write-Host ''
Write-Host '  [3/3] Getting service URL...' -ForegroundColor Yellow
$url = gcloud run services describe $SERVICE_NAME --region $REGION --project $PROJECT_ID --format "value(status.url)"

Write-Host ''
Write-Host '=================================================='
Write-Host "  Deployed!" -ForegroundColor Green
Write-Host "  URL: $url" -ForegroundColor Cyan
Write-Host '=================================================='
Write-Host ''
Write-Host '  Tips:' -ForegroundColor DarkGray
Write-Host '    - カスタムドメイン: gcloud run domain-mappings create ...' -ForegroundColor DarkGray
Write-Host '    - ログ確認: gcloud run services logs read vault-dashboard --region asia-northeast1' -ForegroundColor DarkGray
