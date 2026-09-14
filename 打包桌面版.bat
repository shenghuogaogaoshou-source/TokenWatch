@echo off
chcp 65001 >nul
title 打包 TokenWatch 桌面版
cd /d "%~dp0"

set "PY="
where python >nul 2>nul && set "PY=python"
if "%PY%"=="" where py >nul 2>nul && set "PY=py -3"
if "%PY%"=="" (
  echo [错误] 未找到 Python。
  pause
  exit /b 1
)

%PY% -c "import PyInstaller" >nul 2>nul
if errorlevel 1 (
  echo [错误] 未安装 PyInstaller。请先执行：
  echo     %PY% -m pip install pyinstaller
  pause
  exit /b 1
)

echo [1/3] 结束正在运行的 TokenWatch（否则 exe 被占用，替换会失败）……
taskkill /IM TokenWatch.exe /T /F >nul 2>nul
taskkill /IM TokenWatchLauncher.exe /T /F >nul 2>nul

echo [2/3] 清理旧产物……
echo        dist\TokenWatch 若已存在，COLLECT 会去删它并被安全删除机制拦下，必须先手动删。
if exist "build\TokenWatch" rmdir /s /q "build\TokenWatch"
if exist "dist\TokenWatch" rmdir /s /q "dist\TokenWatch"

echo [3/3] 打包中（注意：不要加 --clean）……
%PY% -m PyInstaller --noconfirm TokenWatch.spec
if errorlevel 1 goto fail

if exist "dist\TokenWatch\TokenWatch.exe" (
  echo.
  echo 打包完成：dist\TokenWatch\TokenWatch.exe
  echo.
  echo 记录安装位置，供桌面启动器自动定位……
  if not exist "%APPDATA%\TokenWatch" mkdir "%APPDATA%\TokenWatch"
  > "%APPDATA%\TokenWatch\install_path.txt" echo %CD%\dist\TokenWatch\TokenWatch.exe
  echo 运行「创建桌面快捷方式.bat」即可在桌面生成图标。
) else (
  goto fail
)
pause
exit /b 0

:fail
echo.
echo [错误] 打包失败，请查看上方输出。
pause
exit /b 1
