const video = document.getElementById('webcam');
const startButton = document.getElementById('start');
const stopButton = document.getElementById('stop');

let accessToken = ''
let refreshToken = ''
let mediaRecorder;
let recordedChunks = [];
let dps = [];
let tick = 0;
let lastUploadedTime = 0;
const maxBufferTime = 15000;
const chunkDuration = 1000;
const longAverage = 1024;
const shortAverage = 256;
const graphLength = 1024;

function checkIsUploadedRecently() {
    const currentTime = new Date().getTime();
    if (currentTime - lastUploadedTime < 10000) {
        lastUploadedTime = currentTime;
        return true;
    } else return false;
}

let chart = new CanvasJS.Chart("chartContainer", {
    title: {
        text: "Amplitude (dB)"
    },
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
    return (value - mean) / stdDev;
}

// 주어진 리스트와 threshold를 받아 처리하는 함수
function checkZScore(samples, threshold) {
    // 1024개의 float 값이 들어있는 리스트를 768개와 256개로 분리
    let firstPart = samples.slice(0, 768);
    let secondPart = samples.slice(768);

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


    if (zScore > threshold) {
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
    const threshold = 10.0;

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
            if (checkIsUploadedRecently()) {
                upload();
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

    const recentChunks = [];

    let accumulatedTime = 0;

    // Iterate backwards through recorded chunks and accumulate duration
    for (let i = recordedChunks.length - 1; i >= 0; i--) {
        const chunk = recordedChunks[i];
        accumulatedTime += chunkDuration;

        // If the accumulated time exceeds max buffer time, stop collecting chunks
        if (accumulatedTime > maxBufferTime) {
            break;
        }

        // Push the chunk to the front of the recentChunks array
        recentChunks.unshift(chunk);
    }

    // Replace the recordedChunks with the recent ones
    recordedChunks = recentChunks;
}

async function initWebcam() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        video.srcObject = stream;

        mediaRecorder = new MediaRecorder(stream);
        mediaRecorder.ondataavailable = event => {
            if (event.data.size > 0) {
                recordedChunks.push(event.data);
                trimBuffer();
            }
        };

        mediaRecorder.start();
        setInterval(() => {
            mediaRecorder.requestData();
        }, 1000);
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
    a.download = 'recent-15seconds.webm';
    a.click();
}



async function upload() {
    let videoBlob = new Blob(recordedChunks, { type: 'video/webm' });
    
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

loginCheck();
setInterval(loginCheck, 1000 * 60);
initWebcam();