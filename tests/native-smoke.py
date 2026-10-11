"""macOS integration test. Plays a quiet synthetic signal through the default device."""

import json
import math
import os
import queue
import random
import struct
import subprocess
import tempfile
import threading
import time
import wave

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

with tempfile.TemporaryDirectory() as directory:
    # Use a repeatable, quiet stereo tone plus noise instead of requiring a fixture file.
    clip = os.path.join(directory, 'signal.wav')
    random.seed(1)
    with wave.open(clip, 'wb') as wav:
        wav.setparams((2, 2, 48000, 0, 'NONE', 'not compressed'))
        samples = [
            int(180 * math.sin(2 * math.pi * 440 * i / 48000) + random.uniform(-60, 60))
            for i in range(48000 * 2)
        ]
        wav.writeframes(b''.join(struct.pack('<hh', sample, sample) for sample in samples))

    process = subprocess.Popen(
        [os.path.join(root, 'native/bin/au-host')],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        text=True,
    )
    events = queue.Queue()

    # Read asynchronously so each assertion can wait for a particular protocol event.
    def read():
        for line in process.stdout:
            events.put(json.loads(line))

    threading.Thread(target=read, daemon=True).start()

    def send(command, **values):
        process.stdin.write(json.dumps(dict(command=command, **values)) + '\n')
        process.stdin.flush()

    def wait(kind, timeout=10):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            message = events.get(timeout=max(.01, end - time.monotonic()))
            if message['type'] == 'error':
                raise AssertionError(message)
            if message['type'] == kind:
                return message
        raise AssertionError('Timeout: ' + kind)

    try:
        ready = wait('ready')
        assert ready['available'], ready
        mix = next(parameter for parameter in ready['parameters'] if parameter['id'] == 0)
        print('AU parameter:', mix)

        send('load', path=clip)
        assert wait('loaded')['channels'] == 2
        send('mix', value=0)
        send('play')
        wait('playing')

        # Ignore startup silence while the effect fills its internal buffers.
        measured = {}
        while len(measured) < 2:
            data = wait('spectrum')
            if max(data['bins']) > -70:
                measured[data['channel']] = data
        for name, data in measured.items():
            assert len(data['bins']) == 1024
            assert all(math.isfinite(value) for value in data['bins'])
            assert max(data['bins']) > -70, (name, max(data['bins']))

        send('pause')
        wait('paused')
        send('mix', value=mix['min'])
        send('bypass', value=True)
        send('play')
        wait('playing')
        wait('ended')

        # Run for more than two clip durations to verify that looping stays active.
        send('restart')
        send('loop', value=True)
        send('mix', value=100)
        send('bypass', value=False)
        send('play')
        wait('playing')
        end = time.monotonic() + 4.5
        count = 0
        while time.monotonic() < end:
            message = events.get(timeout=5)
            assert message['type'] not in ['error', 'ended'], message
            if message['type'] == 'spectrum':
                count += 1
        assert count > 20

        send('pause')
        wait('paused')
        send('load', path='/missing/audio.wav')
        error = events.get(timeout=5)
        while error['type'] == 'spectrum':
            error = events.get(timeout=5)
        assert error['type'] == 'error', error
        print(
            'PASS: load, audio spectra, pause/resume, signed mix, bypass, '
            'end/restart, loop, invalid file'
        )
    finally:
        process.terminate()
        process.wait(timeout=5)
