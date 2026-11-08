# The board's neural voice: one process keeps a Silero model loaded and says what the board sends it.
# Started by src/voice.js with the Python of its own environment, never on its own. One request a line on stdin,
# as JSON {"id", "text", "speaker"}; one answer a line on stdout, {"id", "ok", "wav"} (WAV, base64) or
# {"id", "ok": false, "error"}. The first line out is {"ready": true, "speakers": [...]} once the model is loaded.
# Nothing here goes to the network: the model is a file on disk.
import base64
import io
import json
import sys
import wave

RATE = 48000


def main():
    model_path = sys.argv[1]
    try:
        import torch
        torch.set_num_threads(4)
        model = torch.package.PackageImporter(model_path).load_pickle('tts_models', 'model')
        model.to(torch.device('cpu'))
        speakers = [s for s in getattr(model, 'speakers', []) if s != 'random']
    except Exception as e:  # no torch, no model, a broken file: said once, then the process ends
        print(json.dumps({'ready': False, 'error': f'{type(e).__name__}: {e}'}), flush=True)
        return
    print(json.dumps({'ready': True, 'speakers': speakers}), flush=True)
    for line in sys.stdin:
        try:
            req = json.loads(line)
        except ValueError:
            continue
        rid = req.get('id')
        try:
            audio = model.apply_tts(text=str(req['text']), speaker=str(req['speaker']), sample_rate=RATE,
                                    put_accent=True, put_yo=True)
            pcm = (audio.clamp(-1, 1) * 32767).to(torch.int16).numpy().tobytes()
            buf = io.BytesIO()
            with wave.open(buf, 'wb') as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(RATE)
                w.writeframes(pcm)
            out = {'id': rid, 'ok': True, 'wav': base64.b64encode(buf.getvalue()).decode('ascii')}
        except Exception as e:
            out = {'id': rid, 'ok': False, 'error': f'{type(e).__name__}: {e}'}
        print(json.dumps(out), flush=True)


if __name__ == '__main__':
    main()
