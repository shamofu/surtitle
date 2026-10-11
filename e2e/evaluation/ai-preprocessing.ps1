param(
    [Parameter(Mandatory = $true)][string]$Ffmpeg,
    [Parameter(Mandatory = $true)][string]$SileroModel,
    [Parameter(Mandatory = $true)][string]$OnnxRuntime
)
$ErrorActionPreference = 'Stop'
$evaluationWorkspace = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$evaluationOutput = Join-Path $evaluationWorkspace ('work/ai-evaluation/run-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $evaluationOutput | Out-Null
$evaluationSpeech = Join-Path $evaluationOutput 'speech.wav'
$evaluationSource = Join-Path $evaluationOutput 'speech-six-minutes.flac'
Add-Type -AssemblyName System.Speech
$evaluationVoice = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
    $evaluationVoice.SetOutputToWaveFile($evaluationSpeech)
    $evaluationVoice.Speak('When you learn a language, listen carefully to the whole sentence. Keep the video large and let the words guide your attention. Repeat a useful expression, then continue the story. Learning works best when the tools get out of your way.')
} finally { $evaluationVoice.Dispose() }
& $Ffmpeg -nostdin -hide_banner -loglevel error -n -stream_loop -1 -i $evaluationSpeech -t 360 -ac 1 -ar 16000 -c:a flac $evaluationSource
if ($LASTEXITCODE -ne 0) { throw 'Speech fixture encoding failed' }
Push-Location $evaluationWorkspace
try {
    & cargo run -p surtitle-ai --example redesign_preparation --features development-validation --offline -- $evaluationSource $Ffmpeg $SileroModel $OnnxRuntime (Join-Path $evaluationOutput 'preparation')
    if ($LASTEXITCODE -ne 0) { throw 'Preparation comparison failed' }
    & cargo run -p surtitle-core --example redesign_fsrs_replay --offline -- $evaluationOutput
    if ($LASTEXITCODE -ne 0) { throw 'FSRS replay failed' }
} finally { Pop-Location }
Write-Output $evaluationOutput
