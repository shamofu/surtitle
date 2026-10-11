param(
    [Parameter(Mandatory = $true)][string]$Ffmpeg,
    [switch]$ExecuteProvider,
    [string]$ProviderProfile = (Join-Path $env:LOCALAPPDATA 'app.surtitle.desktop')
)
$ErrorActionPreference = 'Stop'
$evaluationWorkspace = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$evaluationDirectory = Join-Path $evaluationWorkspace ('work/ai-evaluation/recognition-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $evaluationDirectory | Out-Null
$evaluationArchive = Join-Path $evaluationDirectory 'whisper-bin-x64.zip'
Invoke-WebRequest 'https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-x64.zip' -OutFile $evaluationArchive
if ((Get-FileHash -LiteralPath $evaluationArchive -Algorithm SHA256).Hash.ToLowerInvariant() -ne '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb') { throw 'Official binary hash mismatch' }
Expand-Archive -LiteralPath $evaluationArchive -DestinationPath (Join-Path $evaluationDirectory 'whisper')
$evaluationModel = Join-Path $evaluationDirectory 'ggml-base.bin'
Invoke-WebRequest 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin' -OutFile $evaluationModel
if ((Get-FileHash -LiteralPath $evaluationModel -Algorithm SHA256).Hash.ToLowerInvariant() -ne '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe') { throw 'Official model hash mismatch' }
$evaluationCli = Join-Path $evaluationDirectory 'whisper/Release/whisper-cli.exe'
& $evaluationCli --version 2>&1 | Set-Content (Join-Path $evaluationDirectory 'whisper-version.txt') -Encoding utf8
Add-Type -AssemblyName System.Speech
$evaluationFixtures = @(
    @{ id='en'; voice='Microsoft Zira Desktop'; text='Please keep the video large. I want to learn this useful expression, then continue listening to the story.' },
    @{ id='ja'; voice='Microsoft Haruka Desktop'; text='映像を大きく表示してください。役に立つ表現を覚えてから、物語の続きを聞きたいです。' }
)
$evaluationFixtures | ConvertTo-Json | Set-Content (Join-Path $evaluationDirectory 'references.json') -Encoding utf8
$evaluationRuns = @()
foreach ($fixture in $evaluationFixtures) {
    $voice = New-Object System.Speech.Synthesis.SpeechSynthesizer
    try { $voice.SelectVoice($fixture.voice); $voice.SetOutputToWaveFile((Join-Path $evaluationDirectory ($fixture.id + '-tts.wav'))); $voice.Speak($fixture.text) } finally { $voice.Dispose() }
    & $Ffmpeg -nostdin -hide_banner -loglevel error -n -i (Join-Path $evaluationDirectory ($fixture.id + '-tts.wav')) -ar 16000 -ac 1 -c:a pcm_s16le (Join-Path $evaluationDirectory ($fixture.id + '.wav'))
    if ($LASTEXITCODE -ne 0) { throw 'Fixture conversion failed' }
    $timer = [Diagnostics.Stopwatch]::StartNew()
    & $evaluationCli -m $evaluationModel -f (Join-Path $evaluationDirectory ($fixture.id + '.wav')) -l $fixture.id -t 4 -ojf -otxt -of (Join-Path $evaluationDirectory ('whisper-' + $fixture.id)) 2>&1 | Set-Content (Join-Path $evaluationDirectory ('whisper-' + $fixture.id + '.log')) -Encoding utf8
    $timer.Stop()
    if ($LASTEXITCODE -ne 0) { throw 'Local recognition failed' }
    $evaluationRuns += @{ language=$fixture.id; wallMs=$timer.ElapsedMilliseconds; text=(Get-Content -Raw (Join-Path $evaluationDirectory ('whisper-' + $fixture.id + '.txt'))) }
}
$evaluationRuns | ConvertTo-Json | Set-Content (Join-Path $evaluationDirectory 'local-results.json') -Encoding utf8
if ($ExecuteProvider) {
    # Explicit opt-in: exactly two prepared requests. This path never retries.
    $tool = Join-Path $evaluationWorkspace 'target/debug/surtitle-ai-validation.exe'
    $root = Join-Path $evaluationDirectory 'vertex'
    & $tool init --data-root $root --total-usd 2 --per-job-usd 1 --daily-usd 2 --monthly-usd 2 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Validation initialization failed' }
    $id = [string](Get-Content -Raw (Join-Path $ProviderProfile 'preferences.json') | ConvertFrom-Json).credential_id
    if ($id -notmatch '^[a-fA-F0-9]{64}$') { throw 'Configured credential ID invalid' }
    $copiedCredential = Join-Path $root ('credentials/' + $id + '.dpapi')
    Copy-Item -LiteralPath (Join-Path $ProviderProfile ('credentials/' + $id + '.dpapi')) -Destination $copiedCredential
    try {
        & $tool list-models --data-root $root --credential-id $id --location global | Set-Content (Join-Path $evaluationDirectory 'model-discovery.json') -Encoding utf8
        if ($LASTEXITCODE -ne 0) { throw 'Provider metadata discovery failed' }
        & $tool lookup-price --data-root $root --credential-id $id --location global --model-id gemini-3.1-flash-lite 2>&1 | Set-Content (Join-Path $evaluationDirectory 'price-discovery.json') -Encoding utf8
        # This comparison records unpriced usage; catalog failure never becomes a zero charge.
        foreach ($language in @('en','ja')) {
            $prepared = & $tool prepare --data-root $root --credential-id $id --case-id ('recognition-' + $language) --audio-file (Join-Path $evaluationDirectory ($language + '.wav')) --adapter audio --language $language --max-audio-seconds 15 --model-id gemini-3.1-flash-lite --location global --max-output-tokens 2048 --response-mode stream
            if ($LASTEXITCODE -ne 0) { throw 'Bounded preparation failed' }
            $prepared | Set-Content (Join-Path $evaluationDirectory ('prepared-' + $language + '.json')) -Encoding utf8
            $plan = $prepared | ConvertFrom-Json
            if ($plan.manifest.prepared.requests.Count -ne 1 -or $plan.manifest.maxAudioSeconds -ne 15) { throw 'Scope changed' }
            $timer = [Diagnostics.Stopwatch]::StartNew()
            & $tool run --data-root $root --job-id $plan.quote.id --digest $plan.quote.digest --acknowledge-unqualified --approve-unpriced 2>&1 | Set-Content (Join-Path $evaluationDirectory ('vertex-' + $language + '.json')) -Encoding utf8
            $exitCode = $LASTEXITCODE; $timer.Stop()
            @{ language=$language; wallMs=$timer.ElapsedMilliseconds; exitCode=$exitCode } | ConvertTo-Json | Set-Content (Join-Path $evaluationDirectory ('vertex-' + $language + '-timing.json')) -Encoding utf8
            if ($exitCode -ne 0) { throw 'Stopped without retry; inspect the isolated ledger' }
        }
    } finally {
        & $tool report --data-root $root --output (Join-Path $evaluationDirectory 'vertex-report.json') | Out-Null
        $checked = [IO.Path]::GetFullPath($copiedCredential)
        if (!$checked.StartsWith([IO.Path]::GetFullPath($evaluationDirectory) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid cleanup target' }
        Remove-Item -LiteralPath $checked
    }
}
& python -X utf8 (Join-Path $PSScriptRoot 'recognition-summary.py') $evaluationDirectory
if ($LASTEXITCODE -ne 0) { throw 'Recognition summary failed' }
Write-Output $evaluationDirectory
