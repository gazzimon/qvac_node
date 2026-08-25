@echo off
setlocal EnableExtensions EnableDelayedExpansion
title PyrusLLM

REM ===========================================================================
REM  PyrusLLM -- UNICO canal de ejecucion y distribucion.
REM
REM  Este archivo hace las tres cosas y no hay una cuarta:
REM
REM    1. Si el nodo no esta instalado, lo baja.
REM    2. Deja un acceso directo en el Escritorio.
REM    3. Lo lanza y abre el navegador.
REM
REM  Se puede bajar suelto y hacerle doble clic: no hace falta tener nada
REM  instalado antes -- ni Node, ni npm, ni Pear. El binario trae el motor de
REM  inferencia adentro.
REM
REM  POR QUE UN .BAT Y NO UN INSTALADOR MSI
REM
REM  Un .bat se lee. Cualquiera puede abrirlo con el Bloc de notas y ver
REM  exactamente que se baja, de donde y donde queda. Un instalador compilado
REM  pide confianza; esto la ofrece. Y no necesita permisos de administrador:
REM  todo vive en %LOCALAPPDATA%, que es del usuario.
REM
REM  POR QUE LA VENTANA NEGRA NO SE CIERRA
REM
REM  El nodo es un servidor: mientras esta ventana este abierta, tu maquina
REM  esta en la red sirviendo inferencia. Cerrarla apaga el nodo. Es la unica
REM  senal honesta de "esto esta corriendo" que no requiere ir a buscarla al
REM  administrador de tareas.
REM ===========================================================================

set "REPO=gazzimon/qvac_node"
set "DESTDIR=%LOCALAPPDATA%\Programs\pyrusllm"
set "EXE=%DESTDIR%\pyrusllm.exe"
set "URL=https://github.com/%REPO%/releases/latest/download/pyrusllm-win32-x64.exe"

echo.
echo   PyrusLLM
echo   ----------------------------------------------------------
echo.

REM --- ARM64 no tiene binario y hay que decirlo, no fallar raro ------------
if /I "%PROCESSOR_ARCHITECTURE%"=="ARM64" (
  echo   Esta maquina es Windows ARM64 y todavia no hay binario para esa
  echo   plataforma: el motor de inferencia ^(llama.cpp^) no publica prebuild.
  echo.
  echo   Ver NOTES.md, seccion "Fase 1 / plataformas".
  echo.
  pause
  exit /b 1
)

REM --- 1. Acceso directo en el Escritorio ----------------------------------
REM     Va ANTES de todo lo demas, incluido el atajo de modo desarrollo: el
REM     icono es el canal, asi que tiene que existir aunque el nodo despues
REM     no arranque. Se repone solo si el usuario lo borro.
set "LNK=%USERPROFILE%\Desktop\PyrusLLM.lnk"
if not exist "%LNK%" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%LNK%');" ^
    "$s.TargetPath='%~f0';" ^
    "$s.WorkingDirectory='%DESTDIR%';" ^
    "$s.IconLocation=$(if (Test-Path '%EXE%') { '%EXE%,0' } else { 'shell32.dll,13' });" ^
    "$s.Description='PyrusLLM - tu maquina en la red de inferencia';" ^
    "$s.Save()" >nul 2>&1
  if exist "%LNK%" echo   Acceso directo creado en el Escritorio.
)

REM --- Modo desarrollo: si este .bat vive dentro del repo, se usa el codigo -
REM     fuente en vez de bajar nada. Sirve para probar el lanzador sin tener
REM     que publicar un release primero.
set "RAIZ=%~dp0.."
if exist "%RAIZ%\bin.mjs" (
  if exist "%RAIZ%\node_modules\bare-runtime-win32-x64\bin\bare.exe" (
    echo   [dev] se detecto el repo: se corre desde el codigo fuente
    echo.
    pushd "%RAIZ%"
    "%RAIZ%\node_modules\bare-runtime-win32-x64\bin\bare.exe" bin.mjs %*
    popd
    echo.
    echo   El nodo se detuvo.
    pause
    exit /b 0
  )
)

REM --- 2. Instalar si falta ------------------------------------------------
if not exist "%EXE%" (
  echo   No esta instalado todavia. Se baja el nodo ^(~165 MB^).
  echo   Origen: %URL%
  echo.

  if not exist "%DESTDIR%" mkdir "%DESTDIR%" >nul 2>&1

  REM Se baja a un temporal y recien al final se mueve: un corte de red no
  REM puede dejar un ejecutable a medias en el destino.
  set "TMPFILE=%TEMP%\pyrusllm-%RANDOM%%RANDOM%.part"

  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ProgressPreference='SilentlyContinue';" ^
    "try { Invoke-WebRequest -Uri '%URL%' -OutFile '!TMPFILE!' -UseBasicParsing; exit 0 }" ^
    "catch { Write-Host ('   error: ' + $_.Exception.Message); exit 1 }"

  if errorlevel 1 (
    echo.
    echo   No se pudo descargar. Revisa la conexion y volve a intentar.
    echo.
    pause
    exit /b 1
  )

  move /Y "!TMPFILE!" "%EXE%" >nul
  if not exist "%EXE%" (
    echo   La descarga termino pero el archivo no quedo en su lugar.
    pause
    exit /b 1
  )

  echo   Instalado en %EXE%
  echo.
)

REM --- 3. Lanzar ------------------------------------------------------------
echo   Arrancando el nodo. Se abre solo en el navegador.
echo   Cerra esta ventana para apagarlo.
echo.

"%EXE%" %*

REM Si el nodo termina -- por Ctrl+C o por un error -- la ventana no se cierra
REM de golpe: sin esto, un fallo al arrancar parpadea y desaparece, y el que
REM hizo doble clic se queda sin saber que paso.
echo.
echo   El nodo se detuvo.
pause
endlocal
