# Cliente mínimo do Chrome DevTools Protocol via WebSocket (.NET).

function Connect-Cdp {
  param([string]$DebugUrl = 'http://127.0.0.1:9222')
  $list = Invoke-RestMethod -Uri "$DebugUrl/json/list" -TimeoutSec 5
  $page = $list | Where-Object { $_.type -eq 'page' } | Select-Object -First 1
  if (-not $page) { throw "Nenhuma aba CDP em $DebugUrl" }

  $ws = New-Object System.Net.WebSockets.ClientWebSocket
  $uri = [Uri]$page.webSocketDebuggerUrl
  $cts = New-Object System.Threading.CancellationTokenSource
  $cts.CancelAfter(15000)
  $ws.ConnectAsync($uri, $cts.Token).GetAwaiter().GetResult() | Out-Null
  return [pscustomobject]@{ Ws = $ws; Id = 0; Session = $null }
}

function Send-Cdp {
  param($Client, [string]$Method, [hashtable]$Params = @{}, [int]$TimeoutMs = 30000)
  $Client.Id++
  $payload = @{ id = $Client.Id; method = $Method; params = $Params } | ConvertTo-Json -Compress -Depth 12
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $seg = New-Object ArraySegment[byte] -ArgumentList @(,$bytes)
  $Client.Ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null

  $want = $Client.Id
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  $buffer = New-Object byte[] 1024KB
  while ([DateTime]::UtcNow -lt $deadline) {
    $ms = New-Object System.IO.MemoryStream
    do {
      $segR = New-Object ArraySegment[byte] -ArgumentList @(,$buffer)
      $result = $Client.Ws.ReceiveAsync($segR, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
      $ms.Write($buffer, 0, $result.Count)
    } while (-not $result.EndOfMessage)

    $text = [Text.Encoding]::UTF8.GetString($ms.ToArray())
    $obj = $text | ConvertFrom-Json
    if ($null -ne $obj.id -and [int]$obj.id -eq $want) {
      if ($obj.error) { throw "CDP $($Method): $($obj.error.message)" }
      return $obj.result
    }
  }
  throw "Timeout CDP em $Method"
}

function Invoke-CdpEval {
  param($Client, [string]$Expression, [int]$TimeoutMs = 30000)
  $r = Send-Cdp $Client 'Runtime.evaluate' @{
    expression = $Expression
    awaitPromise = $true
    returnByValue = $true
  } -TimeoutMs $TimeoutMs
  if ($r.exceptionDetails) {
    throw "JS: $($r.exceptionDetails.text)"
  }
  return $r.result.value
}

function Close-Cdp {
  param($Client)
  try {
    if ($Client.Ws.State -eq 'Open') {
      $Client.Ws.CloseAsync([System.Net.WebSockets.WebSocketCloseStatus]::NormalClosure, 'bye', [Threading.CancellationToken]::None).GetAwaiter().GetResult() | Out-Null
    }
  } catch {}
}
