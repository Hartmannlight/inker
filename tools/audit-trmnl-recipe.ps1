[CmdletBinding()]
param(
  [Parameter(Mandatory)] [ValidateScript({ Test-Path $_ -PathType Container })] [string] $RecipeRoot
)

# UX-09 analysis helper. It is deliberately offline: it neither downloads nor
# executes anything and only reports names/text already present under RecipeRoot.
$root = (Resolve-Path -LiteralPath $RecipeRoot).Path
$files = Get-ChildItem -LiteralPath $root -Recurse -File
$liquid = @($files | Where-Object { $_.Extension -eq '.liquid' })
$transforms = @($files | Where-Object { $_.Name -match '^transform\.(js|py|rb|php)$' })
$tags = New-Object System.Collections.Generic.HashSet[string]
$filters = New-Object System.Collections.Generic.HashSet[string]
foreach ($file in $liquid) {
  $text = Get-Content -LiteralPath $file.FullName -Raw
  if ($null -eq $text) {
    continue
  }
  [regex]::Matches($text, '{%[-]?\s*([A-Za-z_][A-Za-z0-9_]*)') | ForEach-Object { [void]$tags.Add($_.Groups[1].Value) }
  [regex]::Matches($text, '({{-?\s*(.*?)\s*-?}}|{%[-]?\s*(.*?)\s*[-]?%})', [System.Text.RegularExpressions.RegexOptions]::Singleline) | ForEach-Object {
    $expression = [regex]::Replace($_.Value, '(["''])(?:\\.|(?!\1).)*\1', '')
    [regex]::Matches($expression, '\|\s*([A-Za-z_][A-Za-z0-9_]*)') | ForEach-Object { [void]$filters.Add($_.Groups[1].Value) }
  }
}
[pscustomobject]@{
  root = $root
  hasLicense = [bool]($files.Name -contains 'LICENSE')
  layouts = @($liquid | ForEach-Object { $_.FullName.Substring($root.Length).TrimStart('\','/') } | Where-Object { $_ -match '(full|half_horizontal|half_vertical|quadrant)\.liquid$' })
  hasSharedLiquid = [bool]($liquid.Name -contains 'shared.liquid')
  hasSettings = [bool]($files.Name -contains 'settings.yml')
  transformFiles = @($transforms | ForEach-Object { $_.FullName.Substring($root.Length).TrimStart('\','/') })
  tags = @($tags | Sort-Object)
  filters = @($filters | Sort-Object)
} | ConvertTo-Json -Depth 4
