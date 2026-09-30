$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$stage = Join-Path $env:TEMP 'abap-smartfix-vsix-stage'
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

$pkg = Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$id  = $pkg.name
$ver = $pkg.version
$pub = $pkg.publisher
function Esc([string]$s) { [System.Security.SecurityElement]::Escape($s) }

$tags = ($pkg.keywords -join ',')
$cats = ($pkg.categories -join ',')

$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="$(Esc $id)" Version="$ver" Publisher="$(Esc $pub)" />
    <DisplayName>$(Esc $pkg.displayName)</DisplayName>
    <Description xml:space="preserve">$(Esc $pkg.description)</Description>
    <Tags>$(Esc $tags)</Tags>
    <Categories>$(Esc $cats)</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <License>extension/LICENSE.txt</License>
    <Icon>extension/media/icon.png</Icon>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$(Esc $pkg.engines.vscode)" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Services.Branding.Color" Value="$(Esc $pkg.galleryBanner.color)" />
      <Property Id="Microsoft.VisualStudio.Services.Branding.Theme" Value="$(Esc $pkg.galleryBanner.theme)" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/media/icon.png" Addressable="true" />
  </Assets>
</PackageManifest>
"@

$contentTypes = @"
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".md" ContentType="text/markdown" />
  <Default Extension=".svg" ContentType="image/svg+xml" />
  <Default Extension=".png" ContentType="image/png" />
  <Default Extension=".gif" ContentType="image/gif" />
  <Default Extension=".txt" ContentType="text/plain" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
</Types>
"@

$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText((Join-Path $stage 'extension.vsixmanifest'), $manifest, $utf8)
[System.IO.File]::WriteAllText((Join-Path $stage '[Content_Types].xml'), $contentTypes, $utf8)

# Files to package (keep in sync with .vscodeignore)
$files = @(
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'SCI-COVERAGE.md',
  '.abap-smartfix-rules.example.json',
  'media/icon.svg',
  'media/icon.png',
  'LICENSE'
)
# src/*.js are collected automatically so a newly added module is never left out
$files += Get-ChildItem (Join-Path $root 'src') -Filter *.js | Sort-Object Name | ForEach-Object { 'src/' + $_.Name }
foreach ($f in $files) {
  $p = Join-Path $root ($f -replace '/', '\')
  if (-not (Test-Path $p)) { throw "missing file: $f" }
}

# Every relative require('./x') must be packaged, otherwise activate() fails and no command is registered
foreach ($f in ($files | Where-Object { $_ -like 'src/*.js' })) {
  $src = Get-Content (Join-Path $root ($f -replace '/', '\')) -Raw -Encoding UTF8
  foreach ($m in [regex]::Matches($src, "require\('\./([^']+)'\)")) {
    $dep = 'src/' + $m.Groups[1].Value
    if (-not $dep.EndsWith('.js')) { $dep += '.js' }
    if ($files -notcontains $dep) { throw "$f requires $dep, which is not packaged" }
  }
}

Add-Type -AssemblyName System.IO.Compression | Out-Null
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null

$vsix = Join-Path $root "$id-$ver.vsix"
if (Test-Path $vsix) { Remove-Item -Force $vsix }
$zip = [System.IO.Compression.ZipFile]::Open($vsix, 'Create')
try {
  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $stage 'extension.vsixmanifest'), 'extension.vsixmanifest', 'Optimal') | Out-Null
  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $stage '[Content_Types].xml'), '[Content_Types].xml', 'Optimal') | Out-Null
  foreach ($f in $files) {
    $p = Join-Path $root ($f -replace '/', '\')
    [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $p, $(if ($f -eq 'LICENSE') { 'extension/LICENSE.txt' } else { "extension/$f" }), 'Optimal') | Out-Null
  }
} finally { $zip.Dispose() }

"BUILT: $vsix"
"{0:N1} KB" -f ((Get-Item $vsix).Length / 1KB)
