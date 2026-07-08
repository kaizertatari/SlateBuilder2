' Hidden launcher for refresh-bridge-task.bat — the "Refresh Bridge" scheduled
' task runs this via wscript.exe so no console window appears on the desktop
' (a visible window invites an accidental close, which kills the bridge).
' Self-locating: resolves the .bat next to this script.
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
bat = fso.BuildPath(fso.GetParentFolderName(WScript.ScriptFullName), "refresh-bridge-task.bat")
sh.Run """" & bat & """", 0, False
