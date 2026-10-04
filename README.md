# TokyoMotion Catalog

TokyoMotionのRSSと公式の一覧ページ（先頭8ページ、最大100件）から作品情報・サムネイル・再生数・評価・公式埋め込みURLを取得し、GitHub Pagesで一覧表示するカタログです。動画ファイルは保存・コピー・中継しません。サムネイルをタップしたときだけ、TokyoMotion公式の埋め込みプレイヤーを表示します。

## 初回設定

1. **Settings → Pages → Source** を **GitHub Actions** にする
2. **Actions** から `Update TokyoMotion catalog` を一度手動実行する
3. `Deploy TokyoMotion catalog` が完了するとPagesに反映される

その後は30分ごとにRSSと過去ページを読み込み、`data/videos.json`を更新します。公式ページ側で削除・非公開になった作品は再生できません。

## 注意

TokyoMotionの利用規約に従い、個人・非商用の公式埋め込み用途を前提にしています。公式プレイヤーの改変や動画の保存・再配布は行いません。
