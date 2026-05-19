/* ═══════════════════════════════ PRESET DATA ════════════════════════════════ */
const mockAIDoodles = [
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' fill='none' stroke='%231a1a1a' stroke-width='6' stroke-linecap='round' stroke-linejoin='round'><path d='M20 15 L70 15 L70 85 L20 85 Z'/><path d='M30 15 L30 85'/><path d='M45 40 L60 40'/><path d='M45 55 L60 55'/></svg>",
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' fill='none' stroke='%231a1a1a' stroke-width='6' stroke-linecap='round' stroke-linejoin='round'><circle cx='50' cy='55' r='30'/><path d='M25 40 L20 15 L40 30'/><path d='M75 40 L80 15 L60 30'/><circle cx='40' cy='50' r='4' fill='%231a1a1a'/><circle cx='60' cy='50' r='4' fill='%231a1a1a'/><path d='M45 60 L50 63 L55 60'/></svg>",
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' fill='none' stroke='%231a1a1a' stroke-width='6' stroke-linecap='round' stroke-linejoin='round'><path d='M20 50 C 40 20, 60 20, 80 50 C 60 80, 40 80, 20 50 Z'/><path d='M40 35 C 45 45, 45 55, 40 65'/><path d='M60 35 C 55 45, 55 55, 60 65'/></svg>",
    "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100' fill='none' stroke='%231a1a1a' stroke-width='6' stroke-linecap='round' stroke-linejoin='round'><path d='M30 80 Q 50 20 70 80'/><path d='M25 65 Q 50 55 75 65'/></svg>"
];

/* ═══════════════════════════════ FIREBASE ════════════════════════════════ */
let db = null;
let firebaseReady = false;

try {
    db = firebase.database();
    firebaseReady = true;
} catch (e) {
    console.warn('Firebase not initialized:', e);
    document.getElementById('firebaseWarning').classList.remove('hidden');
}

/* ═══════════════════════════════ USER STATE ════════════════════════════════ */
let currentUserId = localStorage.getItem('praiseUserId') || null;
if (!currentUserId) {
    currentUserId = 'uid_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    localStorage.setItem('praiseUserId', currentUserId);
}
let currentUser = localStorage.getItem('praiseNickname') || '공백이';
let profilePhotoDataUrl = localStorage.getItem('praiseProfilePhoto') || null;
let joinedRoomIds = JSON.parse(localStorage.getItem('praiseJoinedRooms') || '[]');

/* ═══════════════════════════════ RUNTIME STATE ════════════════════════════════ */
let activeRoomId = null;
let activeRoomListener = null;
let currentRoomData = null;
let currentViewPageIdx = {}; // roomId → pageIdx (local per-device)
let stickers = [];
let selectedStickerId = null;

/* ═══════════════════════════════ DOM REFS ════════════════════════════════ */
const screenHome = document.getElementById('screenHome');
const screenRoom = document.getElementById('screenRoom');
const btnGlobalWrite = document.getElementById('btnGlobalWrite');
const roomListContainer = document.getElementById('roomListContainer');
const currentRoomGrid = document.getElementById('currentRoomGrid');
const editorScreen = document.getElementById('editorScreen');
const publishScreen = document.getElementById('publishScreen');
const canvasPopup = document.getElementById('canvasPopup');
const workspace = document.getElementById('editorWorkspace');
const stickerSlider = document.getElementById('stickerSlider');
const stickerSizeRow = document.getElementById('stickerSizeRow');

/* ═══════════════════════════════ HELPERS ════════════════════════════════ */
function getInitial(name) { return (name || '?').charAt(0).toUpperCase(); }

function applyAvatarUI(photoDataUrl, name) {
    const img = document.getElementById('headerAvatarImg');
    const initial = document.getElementById('headerAvatarInitial');
    if (photoDataUrl) {
        img.src = photoDataUrl;
        img.style.display = 'block';
        initial.style.display = 'none';
    } else {
        img.style.display = 'none';
        initial.style.display = '';
        initial.textContent = getInitial(name);
    }
}

/** 이미지를 maxPx × maxPx JPEG로 압축 (Firebase 저장 크기 절감) */
function compressImage(dataUrl, maxPx = 80) {
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
            const ratio = Math.min(maxPx / img.width, maxPx / img.height, 1);
            const canvas = document.createElement('canvas');
            canvas.width = img.width * ratio;
            canvas.height = img.height * ratio;
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/jpeg', 0.7));
        };
        img.src = dataUrl;
    });
}

/** Firebase가 array → object로 변환하는 경우 처리 */
function fbToArray(fbObj, size) {
    const arr = Array(size).fill(null);
    if (!fbObj) return arr;
    for (let i = 0; i < size; i++) {
        arr[i] = (fbObj[i] !== undefined && fbObj[i] !== null) ? fbObj[i] : null;
    }
    return arr;
}

function fbPagesToArr(fbPages) {
    if (!fbPages) return [];
    if (Array.isArray(fbPages)) return fbPages;
    return Object.keys(fbPages)
        .sort((a, b) => Number(a) - Number(b))
        .map(k => fbPages[k]);
}

function showScreen(which) {
    screenHome.classList.toggle('active', which === 'home');
    screenRoom.classList.toggle('active', which === 'room');
    btnGlobalWrite.classList.toggle('hidden', which !== 'room');
}

function saveJoinedRooms() {
    localStorage.setItem('praiseJoinedRooms', JSON.stringify(joinedRoomIds));
}

/* ═══════════════════════════════ INIT ════════════════════════════════ */
function init() {
    document.getElementById('authorNicknameDisplay').innerText = currentUser;
    applyAvatarUI(profilePhotoDataUrl, currentUser);

    // 초대 URL 파라미터 확인
    const urlParams = new URLSearchParams(window.location.search);
    const inviteRoomId = urlParams.get('room');
    if (inviteRoomId) {
        window.history.replaceState({}, '', window.location.pathname);
        joinRoomById(inviteRoomId);
    } else {
        renderHome();
    }
}

/* ═══════════════════════════════ JOIN ROOM ════════════════════════════════ */
async function joinRoomById(roomId) {
    if (!firebaseReady) { alert('Firebase 미설정 상태에서는 초대링크를 사용할 수 없어요.'); renderHome(); return; }
    try {
        const snap = await db.ref(`rooms/${roomId}`).get();
        if (!snap.exists()) {
            alert('존재하지 않는 방이에요! 초대링크를 다시 확인해주세요.');
            renderHome();
            return;
        }
        if (!joinedRoomIds.includes(roomId)) {
            joinedRoomIds.push(roomId);
            saveJoinedRooms();
        }
        openRoom(roomId);
    } catch (err) {
        console.error(err);
        alert('방 연결에 실패했어요.\n' + err.message);
        renderHome();
    }
}

/* ═══════════════════════════════ HOME ════════════════════════════════ */
async function renderHome() {
    showScreen('home');

    if (!joinedRoomIds.length) {
        roomListContainer.innerHTML =
            '<p style="padding:30px 20px;color:#aaa;text-align:center;line-height:2;">' +
            '아직 참여한 방이 없어요!<br>아래 버튼으로 방을 만들거나<br>친구의 초대링크로 참여하세요 😊</p>';
        return;
    }

    roomListContainer.innerHTML =
        '<p style="padding:14px 20px;color:#bbb;font-size:13px;">불러오는 중...</p>';

    if (!firebaseReady) {
        roomListContainer.innerHTML =
            '<p style="padding:20px;color:#e03131;">⚠️ firebase-config.js 설정이 필요해요!</p>';
        return;
    }

    roomListContainer.innerHTML = '';
    for (const roomId of joinedRoomIds) {
        try {
            const snap = await db.ref(`rooms/${roomId}`).get();
            if (!snap.exists()) continue;
            const room = snap.val();
            const pages = fbPagesToArr(room.pages);
            const lastPage = pages[pages.length - 1] || { slots: {} };
            const slots = fbToArray(lastPage.slots, room.maxSlots);
            const filled = slots.filter(Boolean).length;

            const div = document.createElement('div');
            div.className = 'room-card';
            div.innerHTML = `
                <div class="room-info">
                    <h3>${room.name}</h3>
                    <p>${pages.length}번째 장 · 남은 칸 ${room.maxSlots - filled}개</p>
                </div>
                <div class="room-slots">${filled}/${room.maxSlots}</div>`;
            div.addEventListener('click', () => openRoom(roomId));
            roomListContainer.appendChild(div);
        } catch (e) {
            console.warn('Room load failed:', roomId, e);
        }
    }
}

/* ═══════════════════════════════ CREATE ROOM ════════════════════════════════ */
document.getElementById('btnCreateRoom').addEventListener('click', async () => {
    const name = prompt("새 다이어리 방 이름을 정해주세요!");
    if (!name) return;
    const countStr = prompt("몇 명이 함께 쓸 다이어리인가요? (1 / 2 / 3 / 4)", "2");
    const maxSlots = Math.min(4, Math.max(1, parseInt(countStr) || 2));

    if (!firebaseReady) {
        alert('firebase-config.js를 먼저 설정해주세요!');
        return;
    }

    const newRoom = {
        name,
        maxSlots,
        createdAt: Date.now(),
        creatorId: currentUserId,
        pages: [{ slots: {} }]
    };

    try {
        const newRef = db.ref('rooms').push();
        await newRef.set(newRoom);
        const roomId = newRef.key;
        joinedRoomIds.push(roomId);
        saveJoinedRooms();
        openRoom(roomId);
    } catch (err) {
        alert('방 만들기 실패: ' + err.message);
    }
});

/* ═══════════════════════════════ OPEN ROOM (REAL-TIME) ════════════════════════════════ */
function openRoom(roomId) {
    // 이전 리스너 해제
    if (activeRoomListener && activeRoomId) {
        db.ref(`rooms/${activeRoomId}`).off('value', activeRoomListener);
        activeRoomListener = null;
    }

    activeRoomId = roomId;
    showScreen('room');

    // 실시간 리스너 연결
    activeRoomListener = db.ref(`rooms/${roomId}`).on('value', snap => {
        if (!snap.exists()) return;
        currentRoomData = snap.val();
        renderRoomUI();
    });
}

/* ═══════════════════════════════ RENDER ROOM UI ════════════════════════════════ */
function renderRoomUI() {
    if (!currentRoomData) return;
    const room = currentRoomData;
    const pages = fbPagesToArr(room.pages);

    // pageIdx 클램프
    if (currentViewPageIdx[activeRoomId] === undefined) {
        currentViewPageIdx[activeRoomId] = pages.length - 1;
    }
    let pageIdx = currentViewPageIdx[activeRoomId];
    if (pageIdx >= pages.length) pageIdx = pages.length - 1;
    currentViewPageIdx[activeRoomId] = pageIdx;

    const page = pages[pageIdx] || { slots: {} };
    const isLatest = (pageIdx === pages.length - 1);
    const slots = fbToArray(page.slots, room.maxSlots);
    const filled = slots.filter(Boolean).length;

    document.getElementById('currentRoomTitle').innerText = room.name;
    document.getElementById('pageIndicator').innerText = `${pageIdx + 1}번째 장`;
    document.getElementById('btnPrevPage').disabled = (pageIdx === 0);
    document.getElementById('btnNextPage').disabled = isLatest;
    document.getElementById('currentRoomCount').innerText = `${filled}/${room.maxSlots}`;
    document.getElementById('btnPoke').disabled = !(isLatest && filled < room.maxSlots);

    currentRoomGrid.className = `four-cut-board layout-${room.maxSlots}`;

    // 현재 유저 작성 여부 (userId 기반)
    const userHasWritten = !isLatest || slots.some(s => s && s.authorId === currentUserId);

    currentRoomGrid.innerHTML = '';
    slots.forEach(slot => {
        const div = document.createElement('div');
        div.className = slot ? 'space' : 'space empty';

        if (slot) {
            const isMySlot = (slot.authorId === currentUserId);
            const blind = !userHasWritten && !isMySlot;
            div.innerHTML = buildSlotHTML(slot, blind);
        } else {
            div.innerHTML = `<div class="empty-placeholder">+</div>`;
            if (isLatest && !userHasWritten) {
                div.addEventListener('click', () => {
                    openEditor();
                });
            } else if (isLatest) {
                div.innerHTML = `
                    <div style="text-align:center; color:#aaa; pointer-events:none;">
                        <div class="empty-placeholder" style="border-color:#ddd; margin:0 auto 8px;">🔗</div>
                        <div style="font-size:12px; font-weight:600;">초대 / 대기 중</div>
                    </div>`;
                div.title = '클릭해서 초대링크 복사하기!';
                div.addEventListener('click', () => document.getElementById('btnInvite').click());
            }
        }
        currentRoomGrid.appendChild(div);
    });

    document.getElementById('nextPageBox').classList.toggle(
        'hidden', !(isLatest && filled === room.maxSlots)
    );
}

/* ═══════════════════════════════ BUILD SLOT HTML ════════════════════════════════ */
function buildSlotHTML(slot, stickersOnly = false) {
    const stickersHTML = (slot.stickers || []).map(s => {
        const sizePct = Math.round(Math.max(15, s.scale * 23));
        const rot = (Math.random() * 16 - 8).toFixed(1);
        return `<div class="space-doodle" style="left:${s.leftPct}%;top:${s.topPct}%;width:${sizePct}%;padding-bottom:${sizePct}%;transform:translate(-50%,-50%) rotate(${rot}deg);">
            <img class="crayon-effect" src="${s.dataUrl}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain;">
        </div>`;
    }).join('');

    const avatarHTML = slot.authorPhoto
        ? `<img src="${slot.authorPhoto}" alt="">`
        : `<span>${getInitial(slot.author)}</span>`;

    if (stickersOnly) {
        // 스티커는 보이되, 텍스트 위에 흐림 잠금 오버레이
        const lockHTML = `
            <div class="locked-stickers-only">
                <div class="sticker-only-badge">✏️ 내가 먼저 써야 읽을 수 있어요</div>
            </div>`;
        const hintHTML = `<div style="position:absolute;bottom:6px;right:7px;z-index:15;opacity:0.75;">
            <div class="slot-avatar">${avatarHTML}</div></div>`;
        return `${stickersHTML}${lockHTML}${hintHTML}`;
    }

    const authorRowHTML = `
        <div class="entry-author-row">
            <div class="slot-avatar">${avatarHTML}</div>
            <span class="entry-author">— ${slot.author}</span>
        </div>`;
    return `<div class="content-wrap"><div class="entry-a">${slot.a}</div>${authorRowHTML}</div>${stickersHTML}`;
}

/* ═══════════════════════════════ ROOM NAVIGATION ════════════════════════════════ */
document.getElementById('btnBackToHome').addEventListener('click', () => {
    if (activeRoomListener && activeRoomId) {
        db.ref(`rooms/${activeRoomId}`).off('value', activeRoomListener);
        activeRoomListener = null;
    }
    renderHome();
});

document.getElementById('btnPrevPage').addEventListener('click', () => {
    if (currentViewPageIdx[activeRoomId] > 0) {
        currentViewPageIdx[activeRoomId]--;
        renderRoomUI();
    }
});

document.getElementById('btnNextPage').addEventListener('click', () => {
    const pages = fbPagesToArr(currentRoomData.pages);
    if (currentViewPageIdx[activeRoomId] < pages.length - 1) {
        currentViewPageIdx[activeRoomId]++;
        renderRoomUI();
    }
});

document.getElementById('btnPoke').addEventListener('click', () =>
    alert("👉 알림 전송 완료!\n아직 일기를 안 쓴 친구들에게 알림을 보냈습니다."));

document.getElementById('btnCreateNextPage').addEventListener('click', async () => {
    const pages = fbPagesToArr(currentRoomData.pages);
    try {
        await db.ref(`rooms/${activeRoomId}/pages/${pages.length}`).set({
            slots: {}
        });
        currentViewPageIdx[activeRoomId] = pages.length;
    } catch (err) {
        alert('다음 장 만들기 실패: ' + err.message);
    }
});

/* ═══════════════════════════════ INVITE LINK ════════════════════════════════ */
document.getElementById('btnInvite').addEventListener('click', () => {
    const url = `${location.origin}${location.pathname}?room=${activeRoomId}`;
    navigator.clipboard.writeText(url).then(() => {
        alert('🔗 초대링크가 복사되었어요!\n친구에게 붙여넣기해서 보내주세요 😊\n\n' + url);
    }).catch(() => {
        prompt('아래 링크를 복사해서 친구에게 보내주세요:', url);
    });
});

/* ═══════════════════════════════ PROFILE PHOTO ════════════════════════════════ */
document.getElementById('headerAvatar').addEventListener('click', () => {
    document.getElementById('profilePhotoInput').click();
});

document.getElementById('profilePhotoInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
        const compressed = await compressImage(ev.target.result, 80);
        profilePhotoDataUrl = compressed;
        localStorage.setItem('praiseProfilePhoto', compressed);
        applyAvatarUI(compressed, currentUser);
    };
    reader.readAsDataURL(file);
    e.target.value = '';
});

document.getElementById('btnChangeName').addEventListener('click', () => {
    const name = prompt("새 닉네임을 입력하세요");
    if (name) {
        currentUser = name;
        localStorage.setItem('praiseNickname', name);
        document.getElementById('authorNicknameDisplay').innerText = name;
        applyAvatarUI(profilePhotoDataUrl, name);
    }
});

/* ═══════════════════════════════ EDITOR ════════════════════════════════ */
btnGlobalWrite.addEventListener('click', openEditor);

function openEditor() {
    document.getElementById('diaryInput').value = '';
    clearAllStickers();
    document.getElementById('aiLoadingOverlay').classList.add('hidden');
    editorScreen.classList.remove('hidden');
}

document.getElementById('btnCancel').addEventListener('click', () =>
    editorScreen.classList.add('hidden'));

/* ═══════════════════════════════ MULTI-STICKER ════════════════════════════════ */
function clearAllStickers() {
    stickers = []; selectedStickerId = null;
    workspace.querySelectorAll('.draggable-sticker').forEach(el => el.remove());
    stickerSizeRow.classList.add('hidden');
}

function addSticker(dataUrl) {
    const id = Date.now();
    const s = { id, dataUrl, leftPct: 50, topPct: 40, scale: 1 };
    stickers.push(s);
    spawnStickerEl(s);
    selectSticker(id);
    stickerSizeRow.classList.remove('hidden');
}

function spawnStickerEl(s) {
    const el = document.createElement('div');
    el.className = 'draggable-sticker';
    el.dataset.id = s.id;
    el.style.left = s.leftPct + '%';
    el.style.top = s.topPct + '%';
    el.style.transform = `translate(-50%,-50%) scale(${s.scale})`;
    el.innerHTML = `<img class="crayon-effect" src="${s.dataUrl}" style="width:100%;height:100%;object-fit:contain;pointer-events:none;" alt="">`;

    let dragging = false;
    el.addEventListener('pointerdown', e => {
        selectSticker(s.id); dragging = true; el.setPointerCapture(e.pointerId);
    });
    el.addEventListener('pointermove', e => {
        if (!dragging) return;
        const rect = workspace.getBoundingClientRect();
        s.leftPct = Math.max(0, Math.min(100, (e.clientX - rect.left) / rect.width * 100));
        s.topPct = Math.max(0, Math.min(100, (e.clientY - rect.top) / rect.height * 100));
        el.style.left = s.leftPct + '%';
        el.style.top = s.topPct + '%';
    });
    el.addEventListener('pointerup', () => dragging = false);
    workspace.appendChild(el);
}

function selectSticker(id) {
    selectedStickerId = id;
    workspace.querySelectorAll('.draggable-sticker').forEach(el => el.classList.remove('selected'));
    const el = workspace.querySelector(`[data-id="${id}"]`);
    if (el) el.classList.add('selected');
    const s = stickers.find(s => s.id === id);
    if (s && stickerSlider) stickerSlider.value = s.scale;
}

function updateSelectedScale(newScale) {
    const s = stickers.find(s => s.id === selectedStickerId);
    if (!s) return;
    s.scale = Math.max(0.3, Math.min(3, newScale));
    const el = workspace.querySelector(`[data-id="${selectedStickerId}"]`);
    if (el) el.style.transform = `translate(-50%,-50%) scale(${s.scale})`;
    if (stickerSlider) stickerSlider.value = s.scale;
}

stickerSlider.addEventListener('input', () => updateSelectedScale(parseFloat(stickerSlider.value)));
document.getElementById('btnStickerPlus').addEventListener('click', () => {
    const s = stickers.find(s => s.id === selectedStickerId); if (s) updateSelectedScale(s.scale + 0.2);
});
document.getElementById('btnStickerMinus').addEventListener('click', () => {
    const s = stickers.find(s => s.id === selectedStickerId); if (s) updateSelectedScale(s.scale - 0.2);
});
document.getElementById('btnStickerRemove').addEventListener('click', () => {
    if (!selectedStickerId) return;
    stickers = stickers.filter(s => s.id !== selectedStickerId);
    const el = workspace.querySelector(`[data-id="${selectedStickerId}"]`);
    if (el) el.remove();
    selectedStickerId = stickers.length ? stickers[stickers.length - 1].id : null;
    if (selectedStickerId) selectSticker(selectedStickerId);
    else stickerSizeRow.classList.add('hidden');
});

// Pinch-to-zoom
let pinchPointers = {}, initPinchDist = null, initPinchScale = 1;
workspace.addEventListener('pointerdown', e => { pinchPointers[e.pointerId] = { x: e.clientX, y: e.clientY }; });
workspace.addEventListener('pointermove', e => {
    if (pinchPointers[e.pointerId]) pinchPointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    const ids = Object.keys(pinchPointers);
    if (ids.length === 2 && selectedStickerId) {
        const [a, b] = ids.map(id => pinchPointers[id]);
        const dist = Math.hypot(b.x - a.x, b.y - a.y);
        if (!initPinchDist) {
            initPinchDist = dist;
            const s = stickers.find(s => s.id === selectedStickerId);
            initPinchScale = s ? s.scale : 1;
        }
        updateSelectedScale(initPinchScale * (dist / initPinchDist));
    }
});
workspace.addEventListener('pointerup', e => { delete pinchPointers[e.pointerId]; if (Object.keys(pinchPointers).length < 2) initPinchDist = null; });
workspace.addEventListener('pointercancel', e => { delete pinchPointers[e.pointerId]; initPinchDist = null; });

// Mouse wheel resize
workspace.addEventListener('wheel', e => {
    if (!selectedStickerId) return;
    e.preventDefault();
    const s = stickers.find(s => s.id === selectedStickerId);
    if (s) updateSelectedScale(s.scale + (e.deltaY < 0 ? 0.1 : -0.1));
}, { passive: false });

/* ═══════════════════════════════ AI DOODLE ════════════════════════════════ */
document.getElementById('btnSpawnAIDoodle').addEventListener('click', () => {
    document.getElementById('aiLoadingOverlay').classList.remove('hidden');
    setTimeout(() => {
        document.getElementById('aiLoadingOverlay').classList.add('hidden');
        addSticker(mockAIDoodles[Math.floor(Math.random() * mockAIDoodles.length)]);
    }, 1500);
});

/* ═══════════════════════════════ PHOTO STICKER ════════════════════════════════ */
document.getElementById('btnOpenPhotoPicker').addEventListener('click', () => {
    document.getElementById('photoStickerInput').click();
});

document.getElementById('photoStickerInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
        // 이미지가 너무 크면 파이어베이스 오류 나므로 300px 정도로 압축
        const compressed = await compressImage(ev.target.result, 300);
        addSticker(compressed);
    };
    reader.readAsDataURL(file);
    e.target.value = ''; // 같은 이미지 또 고를 수 있게 리셋
});


/* ═══════════════════════════════ CANVAS DRAW ════════════════════════════════ */
const doodleCanvas = document.getElementById('doodleCanvas');
const ctx = doodleCanvas.getContext('2d');
let isDrawing = false, lastX = 0, lastY = 0;

document.getElementById('btnOpenCanvasPopup').addEventListener('click', () => {
    ctx.clearRect(0, 0, doodleCanvas.width, doodleCanvas.height);
    ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    canvasPopup.classList.remove('hidden');
});
document.getElementById('btnCanvasClear').addEventListener('click', () => ctx.clearRect(0, 0, doodleCanvas.width, doodleCanvas.height));
document.getElementById('btnCanvasCancel').addEventListener('click', () => canvasPopup.classList.add('hidden'));
document.getElementById('btnCanvasDone').addEventListener('click', () => {
    addSticker(doodleCanvas.toDataURL('image/png'));
    canvasPopup.classList.add('hidden');
});

doodleCanvas.addEventListener('pointerdown', e => {
    isDrawing = true; doodleCanvas.setPointerCapture(e.pointerId);
    lastX = e.offsetX; lastY = e.offsetY;
});
doodleCanvas.addEventListener('pointermove', e => {
    if (!isDrawing) return;
    ctx.beginPath(); ctx.moveTo(lastX, lastY); ctx.lineTo(e.offsetX, e.offsetY); ctx.stroke();
    lastX = e.offsetX; lastY = e.offsetY;
});
doodleCanvas.addEventListener('pointerup', () => isDrawing = false);
doodleCanvas.addEventListener('pointerleave', () => isDrawing = false);

/* ═══════════════════════════════ PUBLISH ════════════════════════════════ */
document.getElementById('btnGoToPublish').addEventListener('click', async () => {
    if (!document.getElementById('diaryInput').value.trim()) {
        alert("일기를 먼저 적어주세요!"); return;
    }
    const hasRooms = await renderPublishRoomList();
    if (!hasRooms) { alert("발행 가능한 방이 없습니다!"); return; }
    editorScreen.classList.add('hidden');
    publishScreen.classList.remove('hidden');
});

async function renderPublishRoomList() {
    const list = document.getElementById('publishRoomCheckboxList');
    list.innerHTML = '';
    let hasAny = false;

    for (const roomId of joinedRoomIds) {
        try {
            const snap = await db.ref(`rooms/${roomId}`).get();
            if (!snap.exists()) continue;
            const room = snap.val();
            const pages = fbPagesToArr(room.pages);
            const lastPage = pages[pages.length - 1] || { slots: {} };
            const slots = fbToArray(lastPage.slots, room.maxSlots);
            const filled = slots.filter(Boolean).length;
            if (filled >= room.maxSlots) continue;

            // 이미 이 장에 작성했으면 제외
            const alreadyWrote = slots.some(s => s && s.authorId === currentUserId);
            if (alreadyWrote) continue;

            hasAny = true;
            const checked = (roomId === activeRoomId);
            const row = document.createElement('div');
            row.className = `room-checkbox-row${checked ? ' active' : ''}`;
            row.innerHTML = `
                <input type="checkbox" value="${roomId}" ${checked ? 'checked' : ''}>
                <span>${room.name} (${pages.length}번째 장: ${filled}/${room.maxSlots})</span>`;
            row.addEventListener('click', () => {
                const cb = row.querySelector('input');
                cb.checked = !cb.checked;
                row.classList.toggle('active', cb.checked);
            });
            list.appendChild(row);
        } catch (e) {
            console.warn(e);
        }
    }
    return hasAny;
}

document.getElementById('btnCancelPublish').addEventListener('click', () =>
    publishScreen.classList.add('hidden'));

document.getElementById('btnConfirmPublish').addEventListener('click', async () => {
    const selected = document.getElementById('publishRoomCheckboxList').querySelectorAll('input:checked');
    if (!selected.length) { alert("방을 하나 이상 선택하세요!"); return; }

    const entry = {
        a: document.getElementById('diaryInput').value.trim(),
        authorId: currentUserId,
        author: currentUser,
        authorPhoto: profilePhotoDataUrl || null,
        stickers: stickers.map(s => ({
            dataUrl: s.dataUrl, leftPct: s.leftPct, topPct: s.topPct, scale: s.scale
        })),
        writtenAt: Date.now()
    };

    const btn = document.getElementById('btnConfirmPublish');
    btn.disabled = true;
    btn.textContent = '발행 중...';

    try {
        for (const input of selected) {
            const roomId = input.value;
            const snap = await db.ref(`rooms/${roomId}`).get();
            if (!snap.exists()) continue;
            const room = snap.val();
            const pages = fbPagesToArr(room.pages);
            const lastIdx = pages.length - 1;
            const lastPage = pages[lastIdx];
            const slots = fbToArray(lastPage.slots, room.maxSlots);
            const emptyIdx = slots.findIndex(s => !s);
            if (emptyIdx === -1) continue;
            await db.ref(`rooms/${roomId}/pages/${lastIdx}/slots/${emptyIdx}`).set(entry);
        }
        publishScreen.classList.add('hidden');
        editorScreen.classList.add('hidden');
        // 실시간 리스너가 자동으로 UI 갱신
    } catch (err) {
        alert('발행 실패: ' + err.message);
    } finally {
        btn.disabled = false;
        btn.textContent = '쾅! 동시 발행 🐾';
    }
});

/* ═══════════════════════════════ START ════════════════════════════════ */
init();
