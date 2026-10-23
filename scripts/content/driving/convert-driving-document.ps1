param([string]$InputDocument = '', [string]$OutputDocument = '')
$ErrorActionPreference = 'Stop'
$contentRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
if (-not $InputDocument) { $InputDocument = Join-Path $contentRoot '.localtools/content-sources/driving-official/chengde-car-2025.doc' }
if (-not $OutputDocument) { $OutputDocument = Join-Path $contentRoot '.localtools/content-sources/driving-official/chengde-car-2025.docx' }
$inputPath = (Resolve-Path -LiteralPath $InputDocument).Path
$outputPath = [IO.Path]::GetFullPath($OutputDocument)
if (Test-Path -LiteralPath $outputPath) { throw 'Output already exists; reuse it or choose another output path.' }
if ([IO.Path]::GetExtension($outputPath) -ne '.docx') { throw 'The converted output must use .docx.' }
$originalHash = (Get-FileHash -LiteralPath $inputPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($originalHash -ne '37399ae6a5653ff2f7f4b7fd0e5913a2c77bbd66994c20712ed89e9e3a701b51') { throw 'Source DOC differs from the recorded official snapshot; review it before conversion.' }
$word = $null; $document = $null; $priorLinks = $null; $priorSecurity = $null
try {
    # Read only; no visible Word window, macros, or external-link updates.
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false; $word.DisplayAlerts = 0
    $priorSecurity = $word.AutomationSecurity; $word.AutomationSecurity = 3
    $priorLinks = $word.Options.UpdateLinksAtOpen; $word.Options.UpdateLinksAtOpen = $false
    $document = $word.Documents.Open($inputPath, $false, $true, $false)
    $document.SaveAs2($outputPath, 16)
    Write-Output 'Converted the public source into the local cache. The original was opened read only.'
} finally {
    if ($document) { $document.Close(0); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($document) }
    if ($word) {
        if ($null -ne $priorLinks) { $word.Options.UpdateLinksAtOpen = $priorLinks }
        if ($null -ne $priorSecurity) { $word.AutomationSecurity = $priorSecurity }
        $word.Quit(0); [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word)
    }
}
if ((Get-FileHash -LiteralPath $inputPath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $originalHash) { throw 'Source DOC changed unexpectedly.' }
