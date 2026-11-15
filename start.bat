@echo off
rem FireBridge: starts the API (port 8000) and the UI (port 5173) in two windows.
setlocal
cd /d "%~dp0backend"
if not exist .venv\Scripts\activate.bat (
  echo Creating Python environment...
  python -m venv .venv || goto :fail
  call .venv\Scripts\activate.bat
  pip install -r requirements.txt || goto :fail
) else (
  call .venv\Scripts\activate.bat
)
start "FireBridge API" cmd /k "uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1"
cd /d "%~dp0frontend"
if not exist node_modules (
  echo Installing frontend packages...
  call npm ci || goto :fail
)
start "FireBridge UI" cmd /k "npm run dev"
echo.
echo API:  http://localhost:8000/docs
echo UI:   http://localhost:5173
exit /b 0
:fail
echo.
echo Setup failed. Check that Python 3.12 and Node.js 22 are installed and on PATH.
pause
exit /b 1
