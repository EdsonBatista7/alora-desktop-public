$ErrorActionPreference = 'Stop'

$package = Get-Content -LiteralPath (Join-Path $PSScriptRoot '..\package.json') -Raw | ConvertFrom-Json
$releaseDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\release-final'))
$targets = @(
  (Join-Path $releaseDir "Alora-Desktop-Setup-$($package.version)-x64.exe"),
  (Join-Path $releaseDir 'win-unpacked\Alora Desktop.exe')
)
$publisherThumbprint = $null

foreach ($target in $targets) {
  if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
    throw "Artefato de release ausente: $target"
  }

  $signature = Get-AuthenticodeSignature -LiteralPath $target
  if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate) {
    throw "Assinatura Authenticode ausente ou inválida: $target ($($signature.Status))"
  }
  if (-not $signature.TimeStamperCertificate) {
    throw "Carimbo de tempo Authenticode ausente: $target"
  }
  if ($signature.SignerCertificate.EnhancedKeyUsageList.ObjectId.Value -notcontains '1.3.6.1.5.5.7.3.3') {
    throw "O certificado não tem uso de assinatura de código: $target"
  }
  if ($publisherThumbprint -and $signature.SignerCertificate.Thumbprint -ne $publisherThumbprint) {
    throw 'O instalador e o aplicativo foram assinados por identidades diferentes.'
  }

  $publisherThumbprint = $signature.SignerCertificate.Thumbprint
  $hash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
  Write-Output "Assinatura válida: $([System.IO.Path]::GetFileName($target)) · $($signature.SignerCertificate.Subject) · SHA-256 $hash"
}
