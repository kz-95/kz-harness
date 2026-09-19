# Stores the TypeSafe API key as the user environment variable TYPESAFE_API_KEY
# (the name the TypeSafe SDK reads). The key is read with a masked prompt, never
# echoed, and never written to shell history. Restart DSH afterwards.
$secure = Read-Host 'Paste your TypeSafe API key (input is hidden)' -AsSecureString
$plain = [Net.NetworkCredential]::new('', $secure).Password
if ([string]::IsNullOrWhiteSpace($plain)) { Write-Error 'No key entered; nothing changed.'; exit 1 }
[Environment]::SetEnvironmentVariable('TYPESAFE_API_KEY', $plain.Trim(), 'User')
Remove-Variable plain, secure
Write-Host 'TYPESAFE_API_KEY saved for your user. Close and reopen terminals, then restart DSH.'
