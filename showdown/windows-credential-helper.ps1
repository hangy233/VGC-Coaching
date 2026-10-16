# Opt-in helper only. It never enumerates, saves, or exports vault passwords.
# Native layout/lifetime: https://learn.microsoft.com/windows/win32/api/wincred/ns-wincred-credentialw
# Exact current-user read: https://learn.microsoft.com/windows/win32/api/wincred/nf-wincred-credreadw
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$stage = 'INVALID_LOGIN_CONTEXT'
$password = $null; $form = $null; $content = $null; $request = $null
$handler = $null; $http = $null; $response = $null; $stream = $null
$memory = $null; $cancel = $null; $raw = $null; $data = $null; $assertion = $null
$reply = $null; $exitCode = 1
try {
    $inputText = [System.Text.StringBuilder]::new()
    while (($character = [Console]::In.Read()) -ne -1) {
        if ($inputText.Length -ge 16384) { throw 'Invalid context' }
        [void]$inputText.Append([char]$character)
    }
    $context = ConvertFrom-Json -InputObject $inputText.ToString()
    $inputText.Clear() | Out-Null
    $username = $context.username
    $challenge = $context.challenge
    if ($username -isnot [string] -or $username -cnotmatch '^[A-Za-z0-9 _-]{1,18}$' -or $context.origin -cne 'https://play.pokemonshowdown.com' -or $challenge -isnot [string] -or $challenge -cnotmatch '^[0-9]{1,10}\|[^\r\n\0|]{1,8192}$') { throw 'Invalid context' }
    $account = $username.ToLowerInvariant() -replace '[^a-z0-9]', ''
    if (-not $account) { throw 'Invalid context' }
    $target = 'VGC-Coaching/PokemonShowdown/' + $account
    $stage = 'SAVED_CREDENTIAL_UNAVAILABLE'
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text.RegularExpressions;
public static class VGCExactCredential {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential {
        public uint Flags, Type;
        public IntPtr TargetName, Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist, AttributeCount;
        public IntPtr Attributes, TargetAlias, UserName;
    }
    [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);
    [DllImport("advapi32.dll", SetLastError=false)]
    private static extern void CredFree(IntPtr credential);
    public static string ReadExact(string target, string account, out string password) {
        password = null;
        IntPtr pointer;
        if (!CredRead(target, 1, 0, out pointer))
            return Marshal.GetLastWin32Error() == 1168 ? "SAVED_CREDENTIAL_NOT_FOUND" : "SAVED_CREDENTIAL_UNAVAILABLE";
        Credential credential = new Credential();
        try {
            credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
            if (credential.Type != 1 || !String.Equals(Marshal.PtrToStringUni(credential.TargetName), target, StringComparison.OrdinalIgnoreCase)) return "SAVED_CREDENTIAL_UNAVAILABLE";
            string storedUser = Marshal.PtrToStringUni(credential.UserName) ?? "";
            if (Regex.Replace(storedUser.ToLowerInvariant(), "[^a-z0-9]", "") != account) return "SAVED_CREDENTIAL_ACCOUNT_MISMATCH";
            if (credential.CredentialBlob == IntPtr.Zero || credential.CredentialBlobSize == 0 || credential.CredentialBlobSize > 2560 || credential.CredentialBlobSize % 2 != 0) return "SAVED_CREDENTIAL_INVALID";
            password = Marshal.PtrToStringUni(credential.CredentialBlob, (int)credential.CredentialBlobSize / 2);
            if (String.IsNullOrEmpty(password) || password.IndexOf('\0') >= 0 || System.Text.Encoding.UTF8.GetByteCount(password) > 1024) { password = null; return "SAVED_CREDENTIAL_INVALID"; }
            return "OK";
        } finally {
            // Best-effort native buffer clearing; managed strings cannot be guaranteed zeroized.
            if (credential.CredentialBlob != IntPtr.Zero && credential.CredentialBlobSize <= 2560)
                for (int i=0; i<credential.CredentialBlobSize; i++) Marshal.WriteByte(credential.CredentialBlob, i, 0);
            CredFree(pointer);
        }
    }
}
'@
    $readResult = [VGCExactCredential]::ReadExact($target, $account, [ref]$password)
    if ($readResult -cne 'OK') { $stage = $readResult; throw 'Credential unavailable' }

    $stage = 'LOGIN_NETWORK'
    Add-Type -AssemblyName System.Net.Http
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $handler.UseCookies = $false
    $handler.UseDefaultCredentials = $false
    $handler.PreAuthenticate = $false
    $http = [System.Net.Http.HttpClient]::new($handler)
    $http.Timeout = [TimeSpan]::FromSeconds(15)
    $http.DefaultRequestHeaders.Accept.ParseAdd('application/json')
    $cancel = [System.Threading.CancellationTokenSource]::new(15000)
    $form = [System.Collections.Generic.Dictionary[string,string]]::new()
    $form.Add('name', $username); $form.Add('pass', $password); $form.Add('challstr', $challenge)
    $password = $null
    $content = [System.Net.Http.FormUrlEncodedContent]::new($form)
    $form.Clear(); $form = $null
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Post, 'https://play.pokemonshowdown.com/api/login')
    $request.Content = $content
    $response = $http.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead, $cancel.Token).GetAwaiter().GetResult()
    if (-not $response.IsSuccessStatusCode) { $stage = 'LOGIN_REJECTED'; throw 'Login rejected' }
    $stream = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
    $memory = [System.IO.MemoryStream]::new()
    $buffer = [byte[]]::new(4096)
    while (($count = $stream.ReadAsync($buffer, 0, $buffer.Length, $cancel.Token).GetAwaiter().GetResult()) -gt 0) {
        if ($memory.Length + $count -gt 65536) { $stage = 'INVALID_LOGIN_RESPONSE'; throw 'Response too large' }
        $memory.Write($buffer, 0, $count)
    }
    $stage = 'INVALID_LOGIN_RESPONSE'
    $raw = [System.Text.Encoding]::UTF8.GetString($memory.ToArray())
    if ($raw.StartsWith(']')) { $raw = $raw.Substring(1) }
    $data = ConvertFrom-Json -InputObject $raw
    $raw = $null
    if ($data.actionsuccess -eq $false -or ($data.assertion -is [string] -and $data.assertion.StartsWith(';'))) { $stage = 'LOGIN_REJECTED'; throw 'Login rejected' }
    if (-not $data.curuser) { throw 'Invalid response' }
    $loggedUser = ([string]$data.curuser.username).ToLowerInvariant() -replace '[^a-z0-9]', ''
    if (-not $data.curuser.loggedin -or $loggedUser -cne $account) { $stage = 'LOGIN_REJECTED'; throw 'Account mismatch' }
    $assertion = $data.assertion
    if ($assertion -isnot [string] -or $assertion.Length -le 10 -or $assertion.Length -gt 32768 -or $assertion -match '[\x00-\x1f\x7f|]') { throw 'Invalid assertion' }
    # Pinned server/users.ts validateToken fields: signed challenge, userid,
    # user type, timestamp, hostname (then optional fields); signature follows ';'.
    # The server verifies the signature. We bind its account/challenge locally.
    $separator = $assertion.IndexOf(';')
    if ($separator -lt 1 -or [string]::IsNullOrWhiteSpace($assertion.Substring($separator + 1))) { throw 'Invalid assertion' }
    $tokenFields = $assertion.Substring(0, $separator).Split(',')
    if ($tokenFields.Length -lt 5 -or $tokenFields[0] -cne $challenge.Substring($challenge.IndexOf('|') + 1) -or $tokenFields[1] -cne $account) { throw 'Invalid assertion' }
    $reply = @{ok=$true;username=$account;assertion=$assertion} | ConvertTo-Json -Compress
    $exitCode = 0
} catch {
    $allowed = @('INVALID_LOGIN_CONTEXT','SAVED_CREDENTIAL_NOT_FOUND','SAVED_CREDENTIAL_ACCOUNT_MISMATCH','SAVED_CREDENTIAL_INVALID','SAVED_CREDENTIAL_UNAVAILABLE','LOGIN_NETWORK','LOGIN_REJECTED','INVALID_LOGIN_RESPONSE')
    if ($stage -cnotin $allowed) { $stage = 'SAVED_LOGIN_HELPER_FAILED' }
    $reply = @{ok=$false;code=$stage} | ConvertTo-Json -Compress
} finally {
    $password = $null; $raw = $null; $data = $null; $assertion = $null; $tokenFields = $null; $context = $null
    if ($form) { $form.Clear() }; $form = $null
    foreach ($disposable in @($stream,$memory,$response,$request,$content,$http,$handler,$cancel)) {
        if ($null -ne $disposable) { try { $disposable.Dispose() } catch {} }
    }
}
# The only stdout output is this bounded assertion-or-code envelope.
if ([System.Text.Encoding]::UTF8.GetByteCount($reply) -gt 65536) { $reply = '{"ok":false,"code":"INVALID_LOGIN_RESPONSE"}'; $exitCode = 1 }
[Console]::Out.WriteLine($reply)
$reply = $null
exit $exitCode
