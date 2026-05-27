#!/usr/bin/env python3
"""Generate the complete index.html for chisha study system"""

html = []

# === HEAD ===
html.append('''<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>吃啥·学习系统</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
    input,textarea,select{font-size:16px!important}
    .tab-active{color:#f97316}.tab-inactive{color:#9ca3af}
    .card{border-radius:16px;transition:transform .1s}.card:active{transform:scale(.98)}
    .avatar{width:36px;height:36px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:600;color:#fff;flex-shrink:0}
    .avatar-sm{width:28px;height:28px;font-size:11px}.avatar-lg{width:48px;height:48px;font-size:18px}.avatar-xs{width:22px;height:22px;font-size:9px}
    .msg-bubble{max-width:75%;word-break:break-word;position:relative}
    .msg-del{position:absolute;top:-6px;right:-6px;width:18px;height:18px;border-radius:50%;background:#ef4444;color:#fff;font-size:10px;display:none;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.2)}
    .msg-mine .msg-del{display:flex}
    .star{cursor:pointer;font-size:22px}
    .pb-safe{padding-bottom:calc(4rem + env(safe-area-inset-bottom,0px))}
    .slide-up{animation:slideUp .3s ease}
    @keyframes slideUp{from{transform:translateY(100%)}to{transform:translateY(0)}}
    .timer-ring{transition:stroke-dashoffset 1s linear}
    .countdown-bg{background:linear-gradient(135deg,#667eea,#764ba2)}
    .seat{width:44px;height:44px;border-radius:10px;display:flex;align-items:center;justify-content:center;cursor:pointer;transition:all .15s;border:2px solid transparent;font-size:11px}
    .seat:hover{border-color:#f97316}.seat.mine{border-color:#10b981;box-shadow:0 0 8px rgba(16,185,129,.4)}
    .scene-bg{position:fixed;inset:0;z-index:0;transition:background .5s}
    .scene-overlay{position:fixed;inset:0;z-index:1;background:rgba(0,0,0,.25)}
    .scene-ui{position:relative;z-index:2}
    .status-btn.active{background:#f97316;color:#fff;box-shadow:0 2px 8px rgba(249,115,22,.3)}
    .pulse{animation:pulse 2s infinite}@keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
  </style>
</head>
<body class="bg-gray-50 min-h-screen">
<div id="app" class="max-w-lg mx-auto min-h-screen relative">''')

# === LOGIN PAGE ===
html.append('''
<div id="login-page" class="min-h-screen flex flex-col items-center justify-center p-6">
  <div class="w-full max-w-sm">
    <div class="text-center mb-6"><div class="text-5xl mb-3">🍜</div><h1 class="text-2xl font-bold text-gray-800 mb-1">吃啥·学习系统</h1><p class="text-sm text-gray-400">一起加油，我们都在</p></div>
    <div class="countdown-bg rounded-2xl p-5 text-white text-center mb-6 shadow-lg">
      <p class="text-xs opacity-80">2027考研倒计时</p><p class="text-4xl font-bold my-1" id="login-countdown"></p><p class="text-xs opacity-60">2026.12.20</p>
    </div>
    <div class="grid grid-cols-3 gap-3 mb-6" id="login-users"></div>
    <div id="login-form" class="hidden">
      <input type="password" id="login-pwd" placeholder="密码" class="w-full border rounded-xl px-4 py-3 mb-3 text-center outline-none focus:ring-2 focus:ring-orange-300" style="font-size:16px">
      <button onclick="doLogin()" class="w-full bg-orange-500 text-white rounded-xl py-3 font-semibold active:bg-orange-600">登录</button>
      <p id="login-error" class="text-red-500 text-xs text-center mt-2 hidden"></p>
    </div>
  </div>
</div>''')

# === MAIN APP SHELL ===
html.append('''
<div id="main-app" class="hidden pb-safe">
  <header class="bg-white/90 backdrop-blur sticky top-0 z-20 px-4 py-2.5 shadow-sm">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2"><span class="text-lg">🍜</span><h1 class="text-base font-bold">吃啥</h1></div>
      <div id="header-user" class="flex items-center gap-2 cursor-pointer" onclick="showSettings()"></div>
    </div>
    <div class="text-center"><span class="text-xs font-semibold text-purple-600" id="header-countdown"></span></div>
  </header>
  <div id="panel-home" class="p-4"></div>
  <div id="panel-room" class="p-4 hidden"></div>
  <div id="panel-focus" class="p-4 hidden"></div>
  <div id="panel-chat" class="p-4 hidden"></div>
  <div id="panel-stats" class="p-4 hidden"></div>
  <nav class="fixed bottom-0 left-0 right-0 bg-white/90 backdrop-blur border-t z-30 max-w-lg mx-auto">
    <div class="flex h-14">
      <button onclick="switchTab('home')" id="tab-home" class="flex-1 flex flex-col items-center justify-center tab-active"><span class="text-lg">🏠</span><span class="text-xs">首页</span></button>
      <button onclick="switchTab('room')" id="tab-room" class="flex-1 flex flex-col items-center justify-center tab-inactive"><span class="text-lg">🏫</span><span class="text-xs">自习室</span></button>
      <button onclick="switchTab('focus')" id="tab-focus" class="flex-1 flex flex-col items-center justify-center tab-inactive"><span class="text-lg">🍅</span><span class="text-xs">专注</span></button>
      <button onclick="switchTab('chat')" id="tab-chat" class="flex-1 flex flex-col items-center justify-center tab-inactive"><span class="text-lg">💬</span><span class="text-xs">聊天</span></button>
      <button onclick="switchTab('stats')" id="tab-stats" class="flex-1 flex flex-col items-center justify-center tab-inactive"><span class="text-lg">📊</span><span class="text-xs">统计</span></button>
    </div>
  </nav>
</div>''')

# === IMMERSIVE VIEW ===
html.append('''
<div id="immersive-view" class="hidden fixed inset-0 z-40">
  <div id="scene-bg" class="scene-bg"></div><div class="scene-overlay"></div>
  <div class="scene-ui min-h-screen flex flex-col">
    <div class="flex items-center justify-between p-4">
      <button onclick="leaveStudyRoom()" class="bg-white/20 backdrop-blur text-white px-3 py-1.5 rounded-full text-sm">← 离开</button>
      <span class="bg-white/20 backdrop-blur text-white px-3 py-1.5 rounded-full text-sm" id="imm-room"></span>
      <button onclick="showScenePicker()" class="bg-white/20 backdrop-blur text-white px-3 py-1.5 rounded-full text-sm">🎨 换景</button>
    </div>
    <div class="flex-1 flex flex-col items-center justify-center">
      <div class="bg-white/10 backdrop-blur-lg rounded-3xl p-8 text-center text-white shadow-2xl">
        <p class="text-sm opacity-80 mb-1">专注学习中</p>
        <p class="text-5xl font-bold mb-1" id="imm-timer">00:00:00</p>
        <p class="text-xs opacity-60" id="imm-scene"></p>
      </div>
    </div>
    <div class="p-4"><div class="bg-white/10 backdrop-blur rounded-2xl p-3"><p class="text-white text-xs opacity-70 mb-2">同在自习室：</p><div id="imm-peers" class="flex gap-2 flex-wrap"></div></div></div>
  </div>
</div>''')

# === MODAL ===
html.append('''
<div id="modal" class="fixed inset-0 bg-black/40 z-50 hidden flex items-end" onclick="if(event.target===this)closeModal()">
  <div class="bg-white w-full max-w-lg mx-auto rounded-t-3xl p-6 slide-up" id="modal-content"></div>
</div>
</div>''')

print(f"HTML parts: {sum(len(p) for p in html)} chars")
# Write to file
with open('public/index.html', 'w') as f:
    f.write('\n'.join(html))
print("HTML structure written")
