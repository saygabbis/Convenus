. "$PSScriptRoot\CdpClient.ps1"

function Wait-CdpJs {
  param($Client, [string]$Expression, [int]$Seconds = 60)
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  while ([DateTime]::UtcNow -lt $deadline) {
    try {
      $v = Invoke-CdpEval $Client $Expression
      if ($v) { return $v }
    } catch {}
    Start-Sleep -Milliseconds 500
  }
  return $null
}

function Invoke-GoogleLogin {
  param(
    $Client,
    [string]$Email,
    [string]$Password
  )

  Send-Cdp $Client 'Page.enable' | Out-Null
  Send-Cdp $Client 'Runtime.enable' | Out-Null
  Send-Cdp $Client 'Page.navigate' @{ url = 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https://www.youtube.com/&hl=pt-BR' } | Out-Null
  Start-Sleep -Seconds 3

  # Já logado?
  $href = Invoke-CdpEval $Client 'location.href'
  if ($href -match 'youtube\.com' -and $href -notmatch 'accounts\.google') {
    $logged = Wait-CdpJs $Client @'
(() => {
  const t = document.cookie || '';
  return /\b(LOGIN_INFO|SID)=/.test(t) || !!document.querySelector('#avatar-btn, button#avatar-btn, img#img');
})()
'@ 10
    if ($logged) { return @{ ok = $true; already = $true } }
  }

  # Conta salva / "Usar outra conta"
  try {
    Invoke-CdpEval $Client @"
(() => {
  const t = [...document.querySelectorAll('div, li, button, a')].find(el => /outra conta|another account|usar outra/i.test(el.textContent||''));
  if (t) { t.click(); return true; }
  return false;
})()
"@ | Out-Null
    Start-Sleep -Seconds 1
  } catch {}

  # E-mail
  $emailReady = Wait-CdpJs $Client "!!document.querySelector('input[type=email], #identifierId')" 45
  if (-not $emailReady) { throw 'Tela de e-mail do Google nao apareceu (bloqueio/captcha?).' }

  $emailJson = ($Email | ConvertTo-Json)
  Invoke-CdpEval $Client @"
(() => {
  const el = document.querySelector('input[type=email], #identifierId');
  el.focus();
  el.value = '';
  el.dispatchEvent(new Event('input', { bubbles: true }));
  const v = $emailJson;
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  const btn = document.querySelector('#identifierNext button, #identifierNext, button[jsname="LgbsSe"]');
  if (btn) btn.click();
  return true;
})()
"@ | Out-Null

  Start-Sleep -Seconds 2

  # Senha
  $passReady = Wait-CdpJs $Client "!!document.querySelector('input[type=password], input[name=Passwd]')" 45
  if (-not $passReady) {
    # talvez pediu confirmacao / captcha
    $challenge = Invoke-CdpEval $Client "document.body.innerText.slice(0,500)"
    throw "Google nao mostrou a senha. Pode ter pedido verificacao. Trecho: $challenge"
  }

  $passJson = ($Password | ConvertTo-Json)
  Invoke-CdpEval $Client @"
(() => {
  const el = document.querySelector('input[type=password], input[name=Passwd]');
  el.focus();
  el.value = '';
  const v = $passJson;
  el.value = v;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  const btn = document.querySelector('#passwordNext button, #passwordNext, button[jsname="LgbsSe"]');
  if (btn) btn.click();
  return true;
})()
"@ | Out-Null

  # Espera chegar no YouTube / cookies de login
  $ok = Wait-CdpJs $Client @'
(() => {
  const href = location.href || '';
  if (/accounts\.google\.com/.test(href)) {
    const t = (document.body && document.body.innerText) || '';
    if (/nao foi possivel|couldn't sign|unusual activity|verificar|verify/i.test(t)) return false;
    return false;
  }
  if (/youtube\.com/.test(href)) return true;
  return false;
})()
'@ 90

  if (-not $ok) {
    $txt = ''
    try { $txt = Invoke-CdpEval $Client "document.body.innerText.slice(0,400)" } catch {}
    throw "Login Google nao concluiu automaticamente. $txt"
  }

  return @{ ok = $true; already = $false }
}
