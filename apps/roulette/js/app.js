/**
 * AbsCL Portal — コアアプリロジック
 *
 * tools_config.json を読み込んで、ダッシュボードにツールカードを動的生成する。
 * 新しいツールを追加するには tools_config.json に追記するだけでOK。
 */

// ===== ツール一覧を読み込んでカードを生成 =====

document.addEventListener('DOMContentLoaded', async () => {
    const grid = document.getElementById('toolsGrid');
    const hint = document.getElementById('hint');
    const countEl = document.getElementById('toolCount');

    try {
        // tools_config.json を取得
        const res = await fetch('js/tools_config.json');
        const tools = await res.json();

        // ヒント非表示
        hint.style.display = 'none';

        // ツール数を表示
        countEl.textContent = tools.length;

        // 各ツールのカードを生成
        tools.forEach((tool, index) => {
            const card = document.createElement('a');
            card.className = 'tool-card';
            card.href = tool.url;

            // 登場アニメーションの遅延
            card.style.setProperty('--delay', `${index * 0.06}s`);

            card.innerHTML = `
                <span class="tool-card-icon">${tool.icon}</span>
                <span class="tool-card-name">${tool.name}</span>
                <span class="tool-card-desc">${tool.description}</span>
            `;

            grid.appendChild(card);
        });

    } catch (err) {
        // 設定ファイル読み込みエラー
        hint.textContent = '⚠️ ツール設定の読み込みに失敗しました';
        console.error('Failed to load tools_config.json:', err);
    }
});
