<script setup>
import { computed, onMounted, reactive } from 'vue';
import { useSettingsStore } from '@/stores/settings';
import { Modal, message } from 'ant-design-vue';
import { CopyOutlined, PlusOutlined, DeleteOutlined } from '@ant-design/icons-vue';

const settingsStore = useSettingsStore();

const formData = reactive({
    port: 5173,
    authToken: '',
    authTokens: [],
    primaryTokenId: '',
    keepaliveMode: 'comment',
    logLevel: 'info',
    queueBuffer: 2,
    imageLimit: 5
});

const enabledTokens = computed(() => (formData.authTokens || []).filter(t => t.enabled !== false && t.token));

function randomHex(bytes = 24) {
    const arr = new Uint8Array(bytes);
    window.crypto.getRandomValues(arr);
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateTokenValue() {
    return `sk-${randomHex(24)}`;
}

function makeTokenName(index) {
    return `token_${index + 1}`;
}

function makeStableTokenId(token, index = 0) {
    const text = String(token || '');
    if (!text) return `tk_${Date.now().toString(36)}_${index}`;
    // FNV-1a 32-bit hash for deterministic token id generation on WebUI side.
    let hash = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    const normalized = (hash >>> 0).toString(16).padStart(8, '0');
    return `tk_${normalized}`;
}

function ensurePrimaryToken() {
    const list = formData.authTokens || [];
    const exists = list.find(t => t.id === formData.primaryTokenId && t.enabled !== false && t.token);
    if (exists) {
        formData.authToken = exists.token;
        return;
    }
    const firstEnabled = list.find(t => t.enabled !== false && t.token);
    formData.primaryTokenId = firstEnabled?.id || '';
    formData.authToken = firstEnabled?.token || '';
}

function normalizeTokens(raw) {
    const source = Array.isArray(raw) ? raw : [];
    const seen = new Set();
    const out = [];
    for (let i = 0; i < source.length; i++) {
        const item = source[i] || {};
        const token = typeof item.token === 'string' ? item.token.trim() : '';
        if (!token) continue;
        if (seen.has(token)) continue;
        seen.add(token);
        out.push({
            id: (typeof item.id === 'string' && item.id.trim()) ? item.id.trim() : makeStableTokenId(token, i),
            name: (typeof item.name === 'string' && item.name.trim()) ? item.name.trim() : makeTokenName(i),
            token,
            enabled: item.enabled !== false
        });
    }
    return out;
}

function addToken() {
    const idx = formData.authTokens.length;
    formData.authTokens.push({
        id: `tk_${Date.now().toString(36)}_${idx}`,
        name: makeTokenName(idx),
        token: generateTokenValue(),
        enabled: true
    });
    if (!formData.primaryTokenId) {
        formData.primaryTokenId = formData.authTokens[formData.authTokens.length - 1].id;
    }
    ensurePrimaryToken();
}

function removeToken(id) {
    formData.authTokens = formData.authTokens.filter(t => t.id !== id);
    if (formData.primaryTokenId === id) {
        formData.primaryTokenId = '';
    }
    ensurePrimaryToken();
}

async function copyText(text, successMsg) {
    try {
        await navigator.clipboard.writeText(text);
        message.success(successMsg || '已复制');
    } catch (e) {
        message.error('复制失败，请检查浏览器权限');
    }
}

function tokenMasked(token) {
    if (!token) return '***';
    if (token.length < 8) return '***';
    return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

const copyMcpConfig = () => {
    ensurePrimaryToken();
    if (!formData.authToken) {
        message.warning('请先配置并启用至少一个 Token');
        return;
    }

    const snippet = {
        mcpServers: {
            guixuai: {
                command: 'node',
                args: ['YOUR_WEBTOAPI_PATH/scripts/mcp/server.mjs'],
                env: {
                    GUIXUAI_BASE_URL: `${window.location.origin}`,
                    GUIXUAI_API_TOKEN: formData.authToken
                }
            }
        }
    };

    copyText(JSON.stringify(snippet, null, 2), 'MCP 配置已复制');
};

const copyOpenClawSkillInstall = () => {
    ensurePrimaryToken();
    if (!formData.authToken) {
        message.warning('请先配置并启用至少一个 Token');
        return;
    }

    const mcpSnippet = {
        mcpServers: {
            guixuai: {
                command: 'node',
                args: ['YOUR_WEBTOAPI_PATH/scripts/mcp/server.mjs'],
                env: {
                    GUIXUAI_BASE_URL: `${window.location.origin}`,
                    GUIXUAI_API_TOKEN: formData.authToken
                }
            }
        }
    };

    const text = [
        'OpenClaw 一键配置（MCP + Skill）',
        '',
        '[1] MCP 配置（JSON）',
        JSON.stringify(mcpSnippet, null, 2),
        '',
        '[2] Skill 文件路径',
        'YOUR_WEBTOAPI_PATH/SKILL.md',
        '',
        '[3] 安装步骤',
        '在 OpenClaw -> Skills -> Import Local Skill',
        '选择上面的 SKILL.md 后保存即可'
    ].join('\n');
    copyText(text, 'OpenClaw 配置与 Skill 安装内容已复制');
};

onMounted(async () => {
    await settingsStore.fetchServerConfig();
    const cfg = settingsStore.serverConfig || {};

    formData.port = cfg.port ?? 5173;
    formData.authToken = cfg.authToken || '';
    formData.authTokens = normalizeTokens(cfg.authTokens || []);
    formData.primaryTokenId = cfg.primaryTokenId || '';
    formData.keepaliveMode = cfg.keepaliveMode || 'comment';
    formData.logLevel = cfg.logLevel || 'info';
    formData.queueBuffer = cfg.queueBuffer ?? 2;
    formData.imageLimit = cfg.imageLimit ?? 5;

    if (!formData.authTokens.length && formData.authToken) {
        formData.authTokens = [{
            id: 'primary',
            name: 'primary',
            token: formData.authToken,
            enabled: true
        }];
        formData.primaryTokenId = 'primary';
    }

    ensurePrimaryToken();
});

const doSave = async () => {
    formData.authTokens = normalizeTokens(formData.authTokens);
    ensurePrimaryToken();

    const payload = {
        port: formData.port,
        authToken: formData.authToken,
        authTokens: formData.authTokens,
        keepaliveMode: formData.keepaliveMode,
        logLevel: formData.logLevel,
        queueBuffer: formData.queueBuffer,
        imageLimit: formData.imageLimit
    };

    const ok = await settingsStore.saveServerConfig(payload);
    if (ok) {
        message.success('已保存。Token 变更会立即生效（多 token 同时可用）');
    }
};

const handleSave = async () => {
    formData.authTokens = normalizeTokens(formData.authTokens);

    for (const item of formData.authTokens) {
        if (!item.token || item.token.length < 10) {
            message.error(`Token ${item.name} 长度至少 10 个字符`);
            return;
        }
    }

    ensurePrimaryToken();

    if (!formData.authToken) {
        Modal.confirm({
            title: '安全警告',
            content: '当前没有任何可用 Token，API 和 WebUI 将无需认证即可访问。请勿在公网环境中使用此配置。确定继续？',
            okText: '确定继续',
            okType: 'danger',
            cancelText: '取消',
            onOk: doSave
        });
        return;
    }

    await doSave();
};
</script>

<template>
    <a-layout style="background: transparent;">
        <a-card title="服务器设置" :bordered="false" style="width: 100%;">
            <a-row :gutter="[16, 16]">
                <a-col :xs="24" :md="12">
                    <div style="margin-bottom: 8px;">
                        <div style="font-weight: 600; margin-bottom: 4px;">监听端口</div>
                        <a-input-number v-model:value="formData.port" :min="1" :max="65535" placeholder="请输入端口号"
                            style="width: 100%" />
                    </div>
                </a-col>

                <a-col :xs="24" :md="12">
                    <div style="margin-bottom: 8px;">
                        <div style="font-weight: 600; margin-bottom: 4px;">主 Token</div>
                        <a-select v-model:value="formData.primaryTokenId" style="width: 100%" placeholder="选择主 Token"
                            @change="ensurePrimaryToken">
                            <a-select-option v-for="item in enabledTokens" :key="item.id" :value="item.id">
                                {{ item.name }} ({{ tokenMasked(item.token) }})
                            </a-select-option>
                        </a-select>
                    </div>
                </a-col>

                <a-col :xs="24" :md="12">
                    <div style="margin-bottom: 8px;">
                        <div style="font-weight: 600; margin-bottom: 4px;">心跳包类型</div>
                        <a-select v-model:value="formData.keepaliveMode" style="width: 100%" placeholder="请选择心跳包类型">
                            <a-select-option value="comment">Comment - 注释格式</a-select-option>
                            <a-select-option value="content">Content - 内容格式</a-select-option>
                        </a-select>
                    </div>
                </a-col>

                <a-col :xs="24" :md="12">
                    <div style="margin-bottom: 8px;">
                        <div style="font-weight: 600; margin-bottom: 4px;">日志等级</div>
                        <a-select v-model:value="formData.logLevel" style="width: 100%" placeholder="请选择日志等级">
                            <a-select-option value="debug">Debug - 调试日志</a-select-option>
                            <a-select-option value="info">Info - 普通信息</a-select-option>
                            <a-select-option value="warn">Warn - 警告信息</a-select-option>
                            <a-select-option value="error">Error - 仅错误</a-select-option>
                        </a-select>
                    </div>
                </a-col>
            </a-row>

            <a-divider style="margin: 12px 0;" />

            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
                <div style="font-weight: 600;">多 Token 配置</div>
                <a-button type="dashed" size="small" @click="addToken">
                    <template #icon><PlusOutlined /></template>
                    添加 Token
                </a-button>
            </div>
            <div style="font-size: 12px; color: #8c8c8c; margin-bottom: 12px;">
                支持多个 Token 并行调用。请求历史会记录 token 来源，便于审计与统计。
            </div>

            <div v-if="formData.authTokens.length === 0" style="color: #8c8c8c; font-size: 12px; margin-bottom: 12px;">
                暂无 Token，请点击“添加 Token”。
            </div>

            <div v-for="(item, idx) in formData.authTokens" :key="item.id"
                style="display: grid; grid-template-columns: 180px 1fr 90px 90px 64px; gap: 8px; margin-bottom: 8px; align-items: center;">
                <a-input v-model:value="item.name" :placeholder="`名称 ${idx + 1}`" />
                <a-input-password v-model:value="item.token" placeholder="请输入 Token" @change="ensurePrimaryToken" />
                <a-switch v-model:checked="item.enabled" checked-children="启用" un-checked-children="停用"
                    @change="ensurePrimaryToken" />
                <a-button @click="copyText(item.token, 'Token 已复制')">
                    <template #icon><CopyOutlined /></template>
                    复制
                </a-button>
                <a-button danger @click="removeToken(item.id)">
                    <template #icon><DeleteOutlined /></template>
                </a-button>
            </div>

            <a-divider style="margin: 16px 0 12px;" />

            <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                <a-button @click="copyMcpConfig">
                    <template #icon><CopyOutlined /></template>
                    复制 MCP 配置
                </a-button>
                <a-button @click="copyOpenClawSkillInstall">
                    <template #icon><CopyOutlined /></template>
                    复制 OpenClaw 配置+Skill 安装
                </a-button>
            </div>

            <div style="display: flex; justify-content: flex-end; margin-top: 24px;">
                <a-button type="primary" @click="handleSave">保存设置</a-button>
            </div>
        </a-card>

        <a-card title="队列设置" :bordered="false" style="width: 100%; margin-top: 10px;">
            <a-row :gutter="[16, 16]">
                <a-col :xs="24" :md="12">
                    <div style="margin-bottom: 8px;">
                        <div style="font-weight: 600; margin-bottom: 4px;">队列缓冲区大小</div>
                        <a-input-number v-model:value="formData.queueBuffer" :min="0" :max="100" placeholder="默认为 2"
                            style="width: 100%" />
                    </div>
                </a-col>

                <a-col :xs="24" :md="12">
                    <div style="margin-bottom: 8px;">
                        <div style="font-weight: 600; margin-bottom: 4px;">图片数量上限</div>
                        <a-input-number v-model:value="formData.imageLimit" :min="1" :max="10" placeholder="默认为 5"
                            style="width: 100%" />
                    </div>
                </a-col>
            </a-row>

            <div style="display: flex; justify-content: flex-end; margin-top: 24px;">
                <a-button type="primary" @click="handleSave">保存设置</a-button>
            </div>
        </a-card>
    </a-layout>
</template>

<style scoped>
.ant-input-number {
    width: 100%;
}

@media (max-width: 900px) {
    div[style*='grid-template-columns: 180px 1fr 90px 90px 64px'] {
        grid-template-columns: 1fr;
    }
}
</style>
