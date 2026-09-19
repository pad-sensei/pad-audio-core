# Spring Reverb prototype

既存の `spring-reverb-processor.js` を、Pad Senseiの次の音楽用ツール候補として単体試聴するためのローカルPoC。

## 起動

repoルートでHTTPサーバーを起動する。

```bash
python3 -m http.server 8000
```

ブラウザで `http://localhost:8000/demo/spring-reverb.html` を開き、手元の演奏音声を選ぶ。

比較するのは次の4項目だけ。

- Dry
- Wet
- Decay
- Drive

## 受領

このPoCでは製品UI、プリセット、保存、販売、プラグイン化を作らない。

実際の演奏音声で、

1. dryと比べて「このreverbを使う意味」が聞き分けられる
2. decay / driveが音楽的な調整として使える
3. Pad Senseiの独立ツールにする価値があるか、Keys内蔵機能のままでよいか判断できる

ところまでを目的とする。
