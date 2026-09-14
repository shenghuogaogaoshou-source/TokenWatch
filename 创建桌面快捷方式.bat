@echo off
chcp 65001 >nul
title 创建 TokenWatch 桌面快捷方式
cd /d "%~dp0"

set "EXE=%CD%\dist\TokenWatch\TokenWatch.exe"
if not exist "%EXE%" (
  echo [错误] 未找到 %EXE%
  echo 请先运行「打包桌面版.bat」完成打包，再执行本脚本。
  pause
  exit /b 1
)

powershell -NoProfile -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$sc = $ws.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\TokenWatch.lnk');" ^
  "$sc.TargetPath = '%EXE%';" ^
  "$sc.WorkingDirectory = '%CD%\dist\TokenWatch';" ^
  "$sc.IconLocation = '%EXE%',0;" ^
  "$sc.Description = 'TokenWatch · CC Switch 用量监控台';" ^
  "$sc.Save()"

if exist "%USERPROFILE%\Desktop\TokenWatch.lnk" (
  echo 已创建桌面快捷方式：TokenWatch.lnk（双击即可启动）
) else (
  echo 快捷方式可能已创建到其他位置，请检查桌面。
)
pause
