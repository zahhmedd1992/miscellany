# Prove the derived namespace-rewritten files are VALID OOXML by opening them in
# real Word. ONE Application object, Quit exactly once (a second Quit from a
# parallel process kills the first's session). Macros force-disabled.
$ErrorActionPreference = 'Stop'
$targets = @('adv-pandoc-tables','adv-prefix-default','adv-prefix-exotic','adv-prefix-ns0','adv-strict-ooxml')
$root = (Resolve-Path 'corpus/docx/files').Path
$w = New-Object -ComObject Word.Application
$w.Visible = $false
$w.DisplayAlerts = 0
$w.AutomationSecurity = 3          # msoAutomationSecurityForceDisable
$results = @()
foreach ($t in $targets) {
  $p = Join-Path $root "$t.docx"
  try {
    $d = $w.Documents.Open($p, $false, $true, $false)   # ConfirmConversions, ReadOnly, AddToRecentFiles
    $txt = $d.Content.Text
    $results += [pscustomobject]@{
      slug=$t; opened=$true; paragraphs=$d.Paragraphs.Count; tables=$d.Tables.Count
      chars=$txt.Length; sha=(( [System.Security.Cryptography.SHA256]::Create().ComputeHash(
              [System.Text.Encoding]::UTF8.GetBytes($txt)) | ForEach-Object { $_.ToString('x2') }) -join '').Substring(0,16)
      repaired=$false
    }
    $d.Close(0)
  } catch {
    $results += [pscustomobject]@{ slug=$t; opened=$false; paragraphs=0; tables=0; chars=0; sha='-'; repaired=$true }
    Write-Host "  OPEN FAILED $t : $($_.Exception.Message)"
  }
}
$results | Format-Table -AutoSize
try { $w.Quit() } catch { }
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($w) | Out-Null
$results | Format-Table -AutoSize
