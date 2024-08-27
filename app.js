const video = document.getElementById('webcam');
const startButton = document.getElementById('start');
const stopButton = document.getElementById('stop');

let accessToken = ''
let refreshToken = ''
let mediaRecorder;
let recordedChunks = [];
let dps = [];
let tick = 0;
const maxBufferTime = 15000;
const chunkDuration = 1000;
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
        const response = await fetch('https://homerecorder.kro.kr/refresh', {
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
            // Handle token refresh failure (e.g., redirect to login)
        }
    } catch (error) {
        console.error('Error refreshing token:', error);
    }
}

async function authenticatedApiRequest(endpoint, options = {}) {
    let accessToken = localStorage.getItem('accessToken');

    if (!accessToken) {
        console.error('No access token found, please log in first.');
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
            return await response.json();
        } else if (response.status === 401) {
            // Access token expired or unauthorized
            console.log('Access token expired, trying to refresh...');
            await refreshAccessToken();
            accessToken = localStorage.getItem('accessToken');

            if (accessToken) {
                options.headers['Authorization'] = `Bearer ${accessToken}`;
                response = await fetch(endpoint, options);

                if (response.ok) {
                    return await response.json();
                }
            }
        }
        throw new Error(`Request failed with status: ${response.status}`);
    } catch (error) {
        console.error('API request error:', error);
        throw error;
    }
}

function login() {
    const formData = new URLSearchParams();
    formData.append('username', 'test');
    formData.append('password', 'test');


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
            } else {
                console.error('Login failed.');
            }
        })
        .catch(error => console.error('Error:', error));
}

async function startAnomalyDetection() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const audioContext = new AudioContext();
    const mediaStreamAudioSourceNode = audioContext.createMediaStreamSource(stream);
    const analyserNode = audioContext.createAnalyser();
    mediaStreamAudioSourceNode.connect(analyserNode);
    
    let recordedAmplitudes = [];
    let averageRecordedAmplitudes = [];
    const threshold = 0.07;

    const pcmData = new Float32Array(analyserNode.fftSize);
    const onFrame = () => {
        analyserNode.getFloatTimeDomainData(pcmData);
        let sumSquares = 0.0;
        for (const amplitude of pcmData) { sumSquares += amplitude * amplitude; }
        let nowAmplitude = Math.sqrt(sumSquares / pcmData.length);
        recordedAmplitudes.push(nowAmplitude);
        if (recordedAmplitudes.length > 256) {
            recordedAmplitudes.shift();
        }
        const averageEnergy = recordedAmplitudes.reduce((a, b) => a + b, 0) / recordedAmplitudes.length;
        averageRecordedAmplitudes.push(averageEnergy);
        if (averageRecordedAmplitudes.length > 1024) {
            averageRecordedAmplitudes.shift();
        }
        
        //update chart
        dps.push({ x: tick, y: averageEnergy });
        if (dps.length > 1024) {
            dps.shift();
        }
        chart.render();

        document.getElementById("nowdB").innerText = nowAmplitude;
        document.getElementById("averagedB").innerText = averageEnergy;
        document.getElementById("threshold").innerText = threshold;
        if (averageEnergy > threshold) {
            document.getElementById("anomaly-status").innerText = "Anomaly: Yes";
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

initWebcam();

async function upload() {
    let videoBlob = new Blob(recordedChunks, { type: 'video/webm' });
    
    if (videoBlob) {
        try {
            const presignedUrl = await authenticatedApiRequest('https://homerecorder.kro.kr/file/presigned-url', {
                method: 'POST'
            });
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