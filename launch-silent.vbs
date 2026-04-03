' Solana Spread Trader — Silent Borderless Launcher
' Runs launch.bat without showing a CMD window

Set WshShell = CreateObject("WScript.Shell")
WshShell.Run Chr(34) & CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName) & "\launch.bat" & Chr(34), 0, False
