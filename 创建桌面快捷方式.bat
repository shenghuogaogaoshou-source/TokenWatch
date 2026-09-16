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
  "$desk = [Environment]::GetFolderPath('Desktop');" ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$sc = $ws.CreateShortcut($desk + '\TokenWatch.lnk');" ^
  "$sc.TargetPath = '%EXE%';" ^
  "$sc.WorkingDirectory = '%CD%\dist\TokenWatch';" ^
  "$sc.IconLocation = '%EXE%',0;" ^
  "$sc.Description = 'TokenWatch · CC Switch 用量监控台';" ^
  "$sc.Save();" ^
  "if (Test-Path ($desk + '\TokenWatch.lnk')) { Write-Host ('已创建桌面快捷方式：' + $desk + '\TokenWatch.lnk（双击即可启动）') } else { Write-Host '[警告] 快捷方式未创建成功，请手动检查。' }"
pause
