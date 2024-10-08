const video = document.getElementById('webcam');
const startButton = document.getElementById('start');
const stopButton = document.getElementById('stop');

let accessToken = ''
let refreshToken = ''
let recorder = 1;
let mediaRecorder;
let mediaRecorder2;
let recordedChunks = [];
let dps = [];
let tick = 0;
let lastUploadedTime = 0;
let trigger = false;
const maxBufferTime = 15000;
const chunkDuration = 1000;
const longAverage = 512;
const shortAverage = 128;
const graphLength = 1024;
let threshold = 30.0;

function checkIsOkayToUpload() {
    const currentTime = new Date().getTime();
    if (currentTime - lastUploadedTime > 10000) {
        lastUploadedTime = currentTime;
        return true;
    } else return false;
}

let chart = new CanvasJS.Chart("chartContainer", {
    data: [{
        type: "line",
        dataPoints: dps
    }],
    axisY:{
        minimum: 0,
        maximum: 1.0
    }
});

//TOKEN
async function refreshAccessToken() {
    const refreshToken = localStorage.getItem('refreshToken');

    if (!refreshToken) {
        console.error('No refresh token found, please log in again.');
        return;
    }

    try {
        const response = await fetch('https://homerecorder.kro.kr/token/reIssue', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ token: refreshToken })
        });

        if (response.ok) {
            const data = await response.json();
            localStorage.setItem('accessToken', data.accessToken);
            console.log('Access token refreshed.');
        } else {
            console.error('Failed to refresh access token:', response.status, response.statusText);
            activeLoginScreen();
        }
    } catch (error) {
        console.error('Error refreshing token:', error);
        activeLoginScreen();
    }
}

async function authenticatedApiRequest(endpoint, options = {}) {
    let accessToken = localStorage.getItem('accessToken');

    if (!accessToken) {
        console.error('No access token found, please log in first.'); activeLoginScreen();
        return;
    }

    // 기본적인 헤더 설정
    options.headers = {
        ...options.headers,
        'Authorization': `Bearer ${accessToken}`
    };

    try {
        let response = await fetch(endpoint, options);

        if (response.ok) {
            return await response.text();
        } else if (response.status === 401) {
            // Access token expired or unauthorized
            console.log('Access token expired, trying to refresh...');
            await refreshAccessToken();
            accessToken = localStorage.getItem('accessToken');

            if (accessToken) {
                options.headers['Authorization'] = `Bearer ${accessToken}`;
                response = await fetch(endpoint, options);

                if (response.ok) {
                    return await response.text();
                }
            }
        }
        throw new Error(`Request failed with status: ${response.status}`);
    } catch (error) {
        console.error('API request error:', error);
        throw error;
    }
}

function register() {
    let username = document.getElementById('registerUsername').value;
    let password = document.getElementById('registerPassword').value;
    let email = document.getElementById('registerEmail').value;

    const registerButton = document.getElementById('registerButton');

    registerButton.disabled = true;

    fetch('https://homerecorder.kro.kr/user', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            userId: username,
            password: password,
            email: email
        })
    })
        .then(response => {
            if (response.ok) {
                console.log('User registered successfully.');
                toggleHidden('signupForm', 'loginForm');
            } else {
                console.error('User registration failed.');
            }
            registerButton.disabled = false;
        })
        .catch(error => {
            console.error('Error:', error);
            registerButton.disabled = false;
        });

}

function login() {
    const loginButton = document.getElementById('loginButton');
    const loginModal = document.getElementById('loginModal');
    loginButton.disabled = true;
    const formData = new URLSearchParams();

    formData.append('username', document.getElementById('loginUsername').value);
    formData.append('password', document.getElementById('loginPassword').value);


    fetch('https://homerecorder.kro.kr/login', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: formData.toString()
    })
        .then(response => response.json())
        .then(data => {
            if (data.accessToken && data.refreshToken) {
                // JWT 토큰을 로컬 스토리지에 저장
                localStorage.setItem('accessToken', data.accessToken);
                localStorage.setItem('refreshToken', data.refreshToken);
                loginModal.classList.add('hidden');
            } else {
                console.error('Login failed.');
            }
            loginButton.disabled = false;
        })
        .catch(error => {
            console.error('Error:', error);
            loginButton.disabled = false;
        });
}

//Anomaly Detection with Z-score

// Z-score 계산을 위한 함수 정의
function calculateZScore(value, mean, stdDev) {
    if (stdDev < 0.001) {
        stdDev = 0.001;
    }
    return (value - mean) / stdDev;
}

// 주어진 리스트와 threshold를 받아 처리하는 함수
function checkZScore(samples, threshold) {
    // 1024개의 float 값이 들어있는 리스트를 768개와 256개로 분리
    let firstPart = samples.slice(0, shortAverage);
    let secondPart = samples.slice(shortAverage);

    // 768개의 샘플로 평균과 표준편차 계산
    let mean = firstPart.reduce((acc, val) => acc + val, 0) / firstPart.length;
    let variance = firstPart.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / firstPart.length;
    let stdDev = Math.sqrt(variance);

    // 256개의 샘플에 대해 Z-score를 계산하고 threshold를 넘는지 확인
    let secondAverage = secondPart.reduce((acc, val) => acc + val, 0) / secondPart.length;
    let zScore = calculateZScore(secondAverage, mean, stdDev);

    //debug
    document.getElementById("zscore").innerText = zScore;
    // end of debug


    if (zScore > threshold || zScore < -threshold) {
        return true;
    }

    return false;
}

async function startAnomalyDetection() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const audioContext = new AudioContext();
    const mediaStreamAudioSourceNode = audioContext.createMediaStreamSource(stream);
    const analyserNode = audioContext.createAnalyser();
    mediaStreamAudioSourceNode.connect(analyserNode);
    
    let recordedAmplitudes = [];
    let averageRecordedAmplitudes = [];

    const pcmData = new Float32Array(analyserNode.fftSize);
    const onFrame = () => {
        analyserNode.getFloatTimeDomainData(pcmData);
        let sumSquares = 0.0;
        for (const amplitude of pcmData) { sumSquares += amplitude * amplitude; }
        let nowAmplitude = Math.sqrt(sumSquares / pcmData.length);
        recordedAmplitudes.push(nowAmplitude);
        if (recordedAmplitudes.length > shortAverage) {
            recordedAmplitudes.shift();
        }
        const averageEnergy = recordedAmplitudes.reduce((a, b) => a + b, 0) / recordedAmplitudes.length;
        // const averageEnergy = nowAmplitude;
        averageRecordedAmplitudes.push(averageEnergy);
        if (averageRecordedAmplitudes.length > longAverage) {
            averageRecordedAmplitudes.shift();
        }
        
        //update chart
        dps.push({ x: tick, y: averageEnergy });
        if (dps.length > graphLength) {
            dps.shift();
        }
        chart.render();

        //Debug
        document.getElementById("nowdB").innerText = nowAmplitude;
        document.getElementById("averagedB").innerText = averageEnergy;
        document.getElementById("threshold").innerText = threshold;
        if (checkZScore(averageRecordedAmplitudes, threshold)) {
            document.getElementById("anomaly-status").innerText = "Anomaly: Yes";
            if (checkIsOkayToUpload()) {
                trigger = true;
            }
        }
        else {
            document.getElementById("anomaly-status").innerText = "Anomaly: No";
        }
        tick++;
        window.requestAnimationFrame(onFrame);
    };
    requestAnimationFrame(onFrame);
}

startAnomalyDetection().catch(err => {
    document.getElementById("status").innerText = "Error accessing microphone: " + err.message;
});

function trimBuffer() {

    // Iterate backwards through recorded chunks and accumulate duration
    recentChunks = [recordedChunks[recordedChunks.length - 1]];

    // Replace the recordedChunks with the recent ones
    recordedChunks = recentChunks;

    if (trigger) {
        upload();
        trigger = false;
    }
}

async function initWebcam() {
    const cameraSelect = document.getElementById('cameraSelect');
    cameraSelect.addEventListener('change', async () => {
        if (mediaRecorder && mediaRecorder.state === 'recording')
            mediaRecorder.stop();
        if (mediaRecorder2 && mediaRecorder2.state === 'recording')
            mediaRecorder2.stop();
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { deviceId: { exact: cameraSelect.value } },
            audio: true
        });
        video.srcObject = stream;
        recordedChunks = [];
        mediaRecorder = new MediaRecorder(stream);
        mediaRecorder2 = new MediaRecorder(stream);
        mediaRecorder.ondataavailable = event => {
            if (event.data.size > 0) {
                recordedChunks.push(event.data);
                trimBuffer();
            }
        };
        mediaRecorder2.ondataavailable = event => {
            if (event.data.size > 0) {
                recordedChunks.push(event.data);
                trimBuffer();
            }
        };
        mediaRecorder.start();
        mediaRecorder2.start();
    });

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        video.srcObject = stream;
        const cameras = await navigator.mediaDevices.enumerateDevices();
        cameraSelect.innerHTML = '';
        cameras.forEach(camera => {
            if (camera.kind === 'videoinput') {
                const option = document.createElement('option');
                option.value = camera.deviceId;
                option.text = camera.label || `Camera ${cameraSelect.length + 1}`;
                cameraSelect.appendChild(option);
            }
        });
        mediaRecorder = new MediaRecorder(stream);
        mediaRecorder2 = new MediaRecorder(stream);
        mediaRecorder.ondataavailable = event => {
            if (event.data.size > 0) {
                recordedChunks.push(event.data);
                trimBuffer();
            }
        };
        mediaRecorder2.ondataavailable = event => {
            if (event.data.size > 0) {
                recordedChunks.push(event.data);
                trimBuffer();
            }
        };

        mediaRecorder.start();
        mediaRecorder2.start();
        setInterval(async () => {
            console.log(mediaRecorder.state);
            if (recorder == 1) {
                if (mediaRecorder && mediaRecorder.state === 'recording') {
                    mediaRecorder.stop();
                } if (mediaRecorder && mediaRecorder.state === 'inactive') {
                    mediaRecorder.start();
                }
                recorder = 2;
            } else {
                if (mediaRecorder2 && mediaRecorder2.state === 'recording') {
                    mediaRecorder2.stop();
                } if (mediaRecorder2 && mediaRecorder2.state === 'inactive') {
                    mediaRecorder2.start();
                }
                recorder = 1;
            }
        }, 7500);
    } catch (error) {
        console.error('Error accessing webcam:', error);
    }
}

async function dl(){
    const blob = new Blob(recordedChunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    document.body.appendChild(a);
    a.style = 'display: none';
    a.href = url;
    a.download = 'recent.webm';
    a.click();
}



async function upload() {
    let videoBlob = new Blob(recordedChunks, { type: 'video/webm' });
    showToast("capturedAlert");
    if (videoBlob) {
        try {
            let presignedUrl = await authenticatedApiRequest('https://homerecorder.kro.kr/file/presigned-url', {
                method: 'POST'
            });
            presignedUrl = JSON.parse(presignedUrl);
            if (presignedUrl) {
                try {
                    const response = await fetch(presignedUrl, {
                        method: 'PUT',
                        headers: {
                            'Content-Type': 'video/webm'
                        },
                        body: videoBlob
                    });

                    if (response.ok) {
                        console.log('Upload successful!');
                    } else {
                        console.error('Upload failed.');
                    }
                } catch (error) {
                    console.error('Error uploading the video:', error);
                }
            } else {
                console.error('presigned url failed');
            }
        } catch (error) {
            console.error('Error uploading the video:', error);
        }
    }
}

function activeLoginScreen() {
    document.getElementById('loginModal').classList.remove('hidden');
}

function logout() {
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    activeLoginScreen();
}

async function loginCheck() {
    await authenticatedApiRequest('https://homerecorder.kro.kr/tokenCheck', {
        method: 'POST'
    });
}

function toggleHidden(hideElement, showElement) {
    document.getElementById(hideElement).classList.add('hidden');
    document.getElementById(showElement).classList.remove('hidden');
}

function hide(elementId) {
    document.getElementById(elementId).classList.add('hidden');
}

function show(elementId) {
    document.getElementById(elementId).classList.remove('hidden');
}

function showSetting() {
    show('settingModal');
    document.getElementById('settingThreshold').value = threshold;
}

function saveSetting() {
    threshold = parseFloat(document.getElementById('settingThreshold').value);
    hide('settingModal');
}

function showToast(elementId) {
    const toast = document.getElementById(elementId);
    toast.style.visibility = 'visible'; // 토스트 메시지를 보이게 함
    toast.style.opacity = 1; // 투명도를 1로 설정하여 보이도록 함

    // 100ms 후에 토스트 메시지가 서서히 사라지기 시작함
    setTimeout(() => {
        toast.style.opacity = 0; // 서서히 사라지게 만듦
    }, 1000);

    // 5초 후에 토스트 메시지를 완전히 숨김
    setTimeout(() => {
        toast.style.visibility = 'hidden';
    }, 1500); // 100ms + 5초(5000ms)
}

loginCheck();
setInterval(loginCheck, 1000 * 60);
initWebcam();