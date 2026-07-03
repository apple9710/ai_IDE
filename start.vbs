' Launch Claude IDE with no console (cmd) window.
' Runs Electron directly in a hidden process so no black terminal appears.
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(WScript.ScriptFullName)
electron = appDir & "\node_modules\electron\dist\electron.exe"

Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = appDir

If fso.FileExists(electron) Then
  ' Run Electron directly (window style 0 = hidden launcher, Electron opens its own GUI window).
  sh.Run """" & electron & """ """ & appDir & """", 0, False
Else
  ' Fallback: dependencies not installed yet — run npm start hidden.
  sh.Run "cmd /c npm start", 0, False
End If
