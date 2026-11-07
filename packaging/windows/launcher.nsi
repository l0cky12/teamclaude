; TeamClaude.exe, the program the Start Menu, the sign-in Run entry and the
; installer's Finish page start. It shows no window of its own: it runs
; `teamclaude desktop` (start the proxy unless it is running, then open the
; dashboard) on the bundled Node with its console hidden. `--stop` ends the
; proxy instead. Any other parameters, such as --no-open, go to `desktop`.
;
; Built by scripts/build-windows-installer.mjs with -DVERSION, -DSTAGE and
; -DOUTFILE.

Unicode true
!include LogicLib.nsh
!include FileFunc.nsh

Name "TeamClaude"
OutFile "${OUTFILE}"
Icon "${STAGE}\teamclaude.ico"
RequestExecutionLevel user
SilentInstall silent
ManifestDPIAware true

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "TeamClaude"
VIAddVersionKey "FileDescription" "TeamClaude"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "KarpelesLab"
VIAddVersionKey "LegalCopyright" "MIT License"

Section
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "--stop" $1
  ${IfNot} ${Errors}
    ; The bundled Node has its own image name, so this ends the proxy and no
    ; other Node program.
    nsExec::Exec 'taskkill /F /IM teamclaude-node.exe'
    Pop $1
    Quit
  ${EndIf}

  ; nsExec runs the console program with no window and hands back its exit
  ; code and output, so a proxy that fails to start says why instead of
  ; nothing happening.
  nsExec::ExecToStack '"$EXEDIR\node\teamclaude-node.exe" "$EXEDIR\app\src\index.js" desktop $0'
  Pop $1
  Pop $2
  ${If} $1 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "TeamClaude could not start.$\r$\n$\r$\n$2"
    SetErrorLevel 1
  ${EndIf}
SectionEnd
