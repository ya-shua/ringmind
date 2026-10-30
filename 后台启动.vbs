' ringmind - start panel in background (no console window)
' Double-click this: the panel runs hidden, nothing to keep open.

Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = Left(WScript.ScriptFullName, InStrRev(WScript.ScriptFullName, "\"))
sh.Run "powershell -NoProfile -ExecutionPolicy Bypass -File ""start.ps1"" -Quiet", 0, False