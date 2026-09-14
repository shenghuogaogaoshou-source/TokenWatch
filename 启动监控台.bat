@echo off
chcp 65001 >nul
title TokenWatch · CC Switch 用量监控台
cd /d "%~dp0"

set "PY="
where python >nul 2>nul && set "PY=python"
if "%PY%"=="" where py >nul 2>nul && set "PY=py -3"

if "%PY%"=="" (
  echo [错误] 未找到 Python。
  echo 请安装 Python 3.10 及以上版本，并确保 python 已加入 PATH。
  pause
  exit /b 1
)

echo 正在启动 TokenWatch 监控台（首次会自动打开浏览器）……
echo   源码模式无需安装任何第三方依赖（纯标准库）。
echo   关闭本窗口即停止监控。
echo.
%PY% server.py
pause
