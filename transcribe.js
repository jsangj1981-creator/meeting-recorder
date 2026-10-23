/* 미팅 녹음 — AssemblyAI 음성 → 텍스트 변환 (연자 자동 구분)
 * 1) 음성 파일 업로드 → 2) 변환 작업 생성 → 3) 완료될 때까지 상태 확인
 */
(function (root) {
  'use strict';

  const API = 'https://api.assemblyai.com/v2';

  function friendlyError(status, body) {
    if (status === 401 || status === 403) return 'API 키가 올바르지 않습니다. 설정에서 키를 확인해 주세요.';
    if (status === 402) return 'AssemblyAI 크레딧이 부족합니다. 계정의 결제 정보를 확인해 주세요.';
    if (status === 429) return '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.';
    const msg = body && (body.error || body.message);
    return msg ? `AssemblyAI 오류: ${msg}` : `AssemblyAI 오류 (HTTP ${status})`;
  }

  async function request(key, path, opts = {}) {
    let res;
    try {
      res = await fetch(API + path, {
        ...opts,
        headers: { Authorization: key, 'Content-Type': 'application/json', ...(opts.headers || {}) },
      });
    } catch (e) {
      throw new Error('인터넷 연결을 확인해 주세요.');
    }
    let body = null;
    try { body = await res.json(); } catch (e) { /* 본문 없음 */ }
    if (!res.ok) throw new Error(friendlyError(res.status, body));
    return body;
  }

  // 업로드는 진행률을 보여주기 위해 XHR 사용
  function upload(key, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', API + '/upload');
      xhr.setRequestHeader('Authorization', key);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
      xhr.onload = () => {
        let body = null;
        try { body = JSON.parse(xhr.responseText); } catch (e) { /* 무시 */ }
        if (xhr.status >= 200 && xhr.status < 300 && body && body.upload_url) resolve(body.upload_url);
        else reject(new Error(friendlyError(xhr.status, body)));
      };
      xhr.onerror = () => reject(new Error('업로드 중 연결이 끊겼습니다. 인터넷 연결을 확인해 주세요.'));
      xhr.send(blob);
    });
  }

  async function create(key, audioUrl, speakersExpected) {
    const payload = {
      audio_url: audioUrl,
      language_code: 'ko',
      speaker_labels: true,
      punctuate: true,
      format_text: true,
    };
    if (speakersExpected) payload.speakers_expected = Number(speakersExpected);
    const body = await request(key, '/transcript', { method: 'POST', body: JSON.stringify(payload) });
    return body.id;
  }

  function get(key, id) {
    return request(key, '/transcript/' + encodeURIComponent(id));
  }

  // 결과를 받은 뒤 AssemblyAI 서버에 남은 변환 기록을 지운다 (실패해도 무시)
  function remove(key, id) {
    return request(key, '/transcript/' + encodeURIComponent(id), { method: 'DELETE' }).catch(() => {});
  }

  // 결과 → [{speaker: '1', text, start(ms)}] — 연자 라벨 A, B, C… 를 1, 2, 3… 으로 바꾼다
  function toUtterances(result) {
    const order = [];
    const label = (s) => {
      if (!order.includes(s)) order.push(s);
      return String(order.indexOf(s) + 1);
    };
    if (Array.isArray(result.utterances) && result.utterances.length) {
      return result.utterances.map((u) => ({ speaker: label(u.speaker), text: u.text, start: u.start || 0 }));
    }
    return result.text ? [{ speaker: '?', text: result.text, start: 0 }] : [];
  }

  root.Transcriber = { upload, create, get, remove, toUtterances };
})(window);
