#!/usr/bin/env python3
"""Generate verify-dark.html / verify-light.html for the webview harness.
VS Code Dark Modern / Light Modern token values + inlined codicon font."""
import base64, re, sys
WV = '/home/audichuang/research/IntellijPlugin/ClipCodeVSCode/graph/webview-ui'
CODICON = '/home/audichuang/research/IntellijPlugin/ClipCodeVSCode/graph/node_modules/@vscode/codicons/dist'

MONO = "'DejaVu Sans Mono', 'Noto Sans Mono', monospace"
SANS = "system-ui, 'Ubuntu', 'Droid Sans', sans-serif"
DARK = {
 'foreground':'#cccccc','descriptionForeground':'#9d9d9d','disabledForeground':'rgba(204,204,204,0.5)',
 'errorForeground':'#f88070','focusBorder':'#0078d4','textLink-foreground':'#4daafc','textLink-activeForeground':'#4daafc',
 'textCodeBlock-background':'#2b2b2b','textBlockQuote-border':'#616161',
 'editor-background':'#1f1f1f','editor-foreground':'#cccccc','editor-selectionBackground':'#264f78',
 'editor-font-family':MONO,'editor-font-size':'14px','editorWarning-foreground':'#cca700',
 'editorWidget-background':'#202020','editorWidget-border':'#313131',
 'editorHoverWidget-background':'#202020','editorHoverWidget-border':'#454545','editorHoverWidget-foreground':'#cccccc',
 'sideBar-background':'#181818','sideBarSectionHeader-background':'#181818',
 'list-hoverBackground':'#2a2d2e','list-activeSelectionBackground':'#04395e','list-activeSelectionForeground':'#ffffff',
 'panel-border':'#2b2b2b',
 'input-background':'#313131','input-foreground':'#cccccc','input-border':'#3c3c3c','input-placeholderForeground':'#989898',
 'inputValidation-errorBackground':'#5a1d1d','inputValidation-errorBorder':'#be1100','inputValidation-warningBorder':'#b89500',
 'inputValidation-warningForeground':'#cccccc','inputValidation-infoBackground':'#063b49',
 'button-background':'#0078d4','button-foreground':'#ffffff','button-hoverBackground':'#026ec1',
 'button-secondaryBackground':'#313131','button-secondaryForeground':'#cccccc','button-secondaryHoverBackground':'#3c3c3c',
 'badge-background':'#616161','badge-foreground':'#f8f8f8',
 'scrollbarSlider-background':'rgba(121,121,121,0.4)','scrollbarSlider-hoverBackground':'rgba(100,100,100,0.7)',
 'toolbar-hoverBackground':'rgba(90,93,94,0.31)','toolbar-activeBackground':'rgba(99,102,103,0.31)',
 'menu-background':'#1f1f1f','menu-foreground':'#cccccc','menu-border':'#454545','menu-selectionBackground':'#0078d4','menu-selectionForeground':'#ffffff',
 'sash-hoverBorder':'#0078d4','progressBar-background':'#0078d4','testing-iconPassed':'#73c991','charts-green':'#89d185',
 'diffEditor-insertedTextBackground':'rgba(156,204,44,0.2)','diffEditor-removedTextBackground':'rgba(255,0,0,0.2)',
 'diffEditor-insertedLineBackground':'rgba(155,185,85,0.2)','diffEditor-removedLineBackground':'rgba(255,0,0,0.2)',
 'font-family':SANS,'font-size':'13px',
 # scmGraph.* — native Source Control Graph tokens (values read out of
 # 1.136.1's workbench.desktop.main.js registerColor calls; foreground1..5 are
 # theme-independent in native, the ref colours are approximated for the harness).
 'scmGraph-foreground1':'#FFB000','scmGraph-foreground2':'#DC267F','scmGraph-foreground3':'#994F00',
 'scmGraph-foreground4':'#40B0A6','scmGraph-foreground5':'#B66DFF',
 'scmGraph-historyItemBaseRefColor':'#EA5C00','scmGraph-historyItemRefColor':'#007ACC',
 'scmGraph-historyItemRemoteRefColor':'#008000',
 'scmGraph-historyItemHoverDefaultLabelBackground':'#616161',
 'scmGraph-historyItemHoverDefaultLabelForeground':'#f8f8f8',
 'scmGraph-historyItemHoverLabelForeground':'#ffffff',
}
LIGHT = {
 'foreground':'#3b3b3b','descriptionForeground':'#3b3b3b','disabledForeground':'rgba(97,97,97,0.5)',
 'errorForeground':'#f85149','focusBorder':'#005fb8','textLink-foreground':'#005fb8','textLink-activeForeground':'#005fb8',
 'textCodeBlock-background':'#f8f8f8','textBlockQuote-border':'#e5e5e5',
 'editor-background':'#ffffff','editor-foreground':'#3b3b3b','editor-selectionBackground':'#add6ff',
 'editor-font-family':MONO,'editor-font-size':'14px','editorWarning-foreground':'#bf8803',
 'editorWidget-background':'#f8f8f8','editorWidget-border':'#e5e5e5',
 'editorHoverWidget-background':'#f8f8f8','editorHoverWidget-border':'#c8c8c8','editorHoverWidget-foreground':'#3b3b3b',
 'sideBar-background':'#f8f8f8','sideBarSectionHeader-background':'#f8f8f8',
 'list-hoverBackground':'#f2f2f2','list-activeSelectionBackground':'#e8e8e8','list-activeSelectionForeground':'#000000',
 'panel-border':'#e5e5e5',
 'input-background':'#ffffff','input-foreground':'#3b3b3b','input-border':'#cecece','input-placeholderForeground':'#767676',
 'inputValidation-errorBackground':'#f2dede','inputValidation-errorBorder':'#be1100','inputValidation-warningBorder':'#b89500',
 'inputValidation-warningForeground':'#3b3b3b','inputValidation-infoBackground':'#d6ecf2',
 'button-background':'#005fb8','button-foreground':'#ffffff','button-hoverBackground':'#0258a8',
 'button-secondaryBackground':'#e5e5e5','button-secondaryForeground':'#3b3b3b','button-secondaryHoverBackground':'#cccccc',
 'badge-background':'#cccccc','badge-foreground':'#3b3b3b',
 'scrollbarSlider-background':'rgba(100,100,100,0.4)','scrollbarSlider-hoverBackground':'rgba(100,100,100,0.7)',
 'toolbar-hoverBackground':'rgba(184,184,184,0.31)','toolbar-activeBackground':'rgba(166,166,166,0.31)',
 'menu-background':'#ffffff','menu-foreground':'#3b3b3b','menu-border':'#cecece','menu-selectionBackground':'#005fb8','menu-selectionForeground':'#ffffff',
 'sash-hoverBorder':'#005fb8','progressBar-background':'#005fb8','testing-iconPassed':'#73c991','charts-green':'#388a34',
 'diffEditor-insertedTextBackground':'rgba(156,204,44,0.2)','diffEditor-removedTextBackground':'rgba(255,0,0,0.2)',
 'diffEditor-insertedLineBackground':'rgba(155,185,85,0.2)','diffEditor-removedLineBackground':'rgba(255,0,0,0.2)',
 'font-family':SANS,'font-size':'13px',
 # scmGraph.* — native Source Control Graph tokens (values read out of
 # 1.136.1's workbench.desktop.main.js registerColor calls; foreground1..5 are
 # theme-independent in native, the ref colours are approximated for the harness).
 'scmGraph-foreground1':'#FFB000','scmGraph-foreground2':'#DC267F','scmGraph-foreground3':'#994F00',
 'scmGraph-foreground4':'#40B0A6','scmGraph-foreground5':'#B66DFF',
 'scmGraph-historyItemBaseRefColor':'#EA5C00','scmGraph-historyItemRefColor':'#007ACC',
 'scmGraph-historyItemRemoteRefColor':'#008000',
 'scmGraph-historyItemHoverDefaultLabelBackground':'#616161',
 'scmGraph-historyItemHoverDefaultLabelForeground':'#f8f8f8',
 'scmGraph-historyItemHoverLabelForeground':'#ffffff',
}

ttf = base64.b64encode(open(f'{CODICON}/codicon.ttf','rb').read()).decode()
css = open(f'{CODICON}/codicon.css').read()
css = re.sub(r'url\("\./codicon\.ttf[^"]*"\)', f'url("data:font/ttf;base64,{ttf}")', css)

for name, vars_, cls in (('dark', DARK, 'vscode-dark'), ('light', LIGHT, 'vscode-light')):
    decl = '\n'.join(f'  --vscode-{k}: {v};' for k, v in vars_.items())
    html = f'''<!doctype html>
<html><head><meta charset="utf-8" /><title>verify {name}</title>
<style>
:root {{
{decl}
}}
html, body {{ margin: 0; height: 100%; }}
body {{ background: var(--vscode-editor-background); color: var(--vscode-foreground);
       font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); }}
#app {{ width: 100vw; height: 100vh; }}
</style>
<style>{css}</style>
</head>
<body class="{cls}"><div id="app"></div>
<script type="module" src="/src/verify-harness.ts"></script>
</body></html>
'''
    open(f'{WV}/verify-{name}.html', 'w').write(html)
    print('wrote', f'{WV}/verify-{name}.html', len(html))
