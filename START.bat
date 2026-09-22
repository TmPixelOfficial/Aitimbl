@echo off
setlocal
cd /d "%~dp0"
title TIMBLOGPLAY AI
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js не найден.
  echo Установи Node.js 20+ и снова запусти START.bat.
  echo Официальный сайт: https://nodejs.org/
  pause
  exit /b 1
)
if not exist node_modules (
  echo [1/2] Устанавливаю зависимости...
  call npm install
  if errorlevel 1 (
    echo.
    echo [ERROR] Не удалось установить зависимости.
    pause
    exit /b 1
  )
)
if not exist .env (
  copy /y .env.example .env >nul
  echo.
  echo Создан .env из .env.example.
  echo Открой .env и добавь ключ AI-провайдера перед первым запуском.
  echo.
)
echo [2/2] Запускаю TIMBLOGPLAY AI...
echo Открой в браузере: http://localhost:3000
start "" http://localhost:3000
node server.js
pause
