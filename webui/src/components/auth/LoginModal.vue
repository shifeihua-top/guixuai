<script setup>
import { computed, reactive, ref, watch } from 'vue';
import { useSettingsStore } from '@/stores/settings';
import { message } from 'ant-design-vue';
import { LockOutlined, UserOutlined } from '@ant-design/icons-vue';

const props = defineProps({
    visible: {
        type: Boolean,
        required: true
    }
});

const emit = defineEmits(['update:visible', 'success']);

const settingsStore = useSettingsStore();
const token = ref(settingsStore.token);
const loading = ref(false);
const loginMode = ref('token'); // token | account | setup

const authMeta = ref({
    authEnabled: true,
    adminConfigured: false,
    setupRequired: false,
    isDefaultToken: false
});

const accountForm = reactive({
    username: '',
    password: ''
});

const setupForm = reactive({
    username: 'admin',
    password: '',
    confirmPassword: '',
    authToken: ''
});

const showLoginModeSwitch = computed(() => authMeta.value.adminConfigured && !authMeta.value.setupRequired);

async function refreshAuthMode() {
    const info = await settingsStore.fetchAuthMode();
    if (info) {
        authMeta.value = info;
    }

    if (authMeta.value.setupRequired) {
        loginMode.value = 'setup';
    } else if (authMeta.value.adminConfigured) {
        loginMode.value = 'account';
    } else if (!authMeta.value.adminConfigured && loginMode.value !== 'token') {
        loginMode.value = 'token';
    }
}

const handleLogin = async () => {
    if (!token.value) {
        message.warning('请输入 Token');
        return;
    }

    loading.value = true;
    try {
        const originalToken = settingsStore.token;
        settingsStore.setToken(token.value);

        const success = await settingsStore.checkAuth();
        if (success) {
            message.success('验证成功');
            emit('success');
            emit('update:visible', false);
        } else {
            message.error('Token 验证失败，请检查是否正确');
            settingsStore.setToken(originalToken);
        }
    } catch (e) {
        message.error('验证过程发生错误');
    } finally {
        loading.value = false;
    }
};

const handlePasswordLogin = async () => {
    if (!accountForm.username || !accountForm.password) {
        message.warning('请输入账号和密码');
        return;
    }

    loading.value = true;
    try {
        const result = await settingsStore.loginWithPassword(accountForm.username, accountForm.password);
        if (!result.success || !result.token) {
            message.error(result.message || '账号密码登录失败');
            return;
        }

        settingsStore.setToken(result.token);
        message.success('登录成功');
        emit('success');
        emit('update:visible', false);
    } finally {
        loading.value = false;
    }
};

const handleSetup = async () => {
    const username = setupForm.username?.trim();
    const password = setupForm.password || '';
    const confirmPassword = setupForm.confirmPassword || '';

    if (!username || username.length < 3) {
        message.warning('用户名至少 3 个字符');
        return;
    }
    if (!password || password.length < 8) {
        message.warning('密码至少 8 个字符');
        return;
    }
    if (password !== confirmPassword) {
        message.warning('两次输入的密码不一致');
        return;
    }
    if (setupForm.authToken && setupForm.authToken.length < 10) {
        message.warning('Token 如果填写，至少需要 10 个字符');
        return;
    }

    loading.value = true;
    try {
        const result = await settingsStore.setupInitialAuth({
            username,
            password,
            authToken: setupForm.authToken || ''
        });
        if (!result.success || !result.token) {
            message.error(result.message || '初始化失败');
            return;
        }

        settingsStore.setToken(result.token);
        message.success(result.generatedToken ? '初始化成功，已自动生成 Token 并登录' : '初始化成功');
        emit('success');
        emit('update:visible', false);
    } finally {
        loading.value = false;
    }
};

watch(
    () => props.visible,
    async (visible) => {
        if (!visible) return;
        token.value = settingsStore.token;
        await refreshAuthMode();
    },
    { immediate: true }
);
</script>

<template>
    <a-modal :open="visible" :title="authMeta.setupRequired ? '首次初始化' : '需要身份验证'" :closable="false"
        :maskClosable="false" :footer="null" width="420px"
        centered>
        <div style="padding: 20px 0;">
            <div style="text-align: center; margin-bottom: 24px;">
                <a-avatar :size="64" style="background-color: #1890ff">
                    <template #icon>
                        <LockOutlined />
                    </template>
                </a-avatar>
                <div style="margin-top: 16px; font-size: 16px; font-weight: 500;">
                    GuiXuAI (万智归墟) 管理面板
                </div>
                <div style="color: #8c8c8c; margin-top: 8px;" v-if="authMeta.setupRequired">
                    首次启动，请先设置管理账号与密码
                </div>
                <div style="color: #8c8c8c; margin-top: 8px;" v-else>
                    使用 Token 或账号密码登录
                </div>
            </div>

            <a-alert v-if="authMeta.setupRequired" type="info" show-icon
                message="初始化后会自动进入系统，并把 Token 写入当前浏览器会话，后续无需手动改配置文件。"
                style="margin-bottom: 16px;" />

            <div v-if="showLoginModeSwitch" style="margin-bottom: 16px; text-align: center;">
                <a-radio-group v-model:value="loginMode" button-style="solid">
                    <a-radio-button value="account">账号密码</a-radio-button>
                    <a-radio-button value="token">Token</a-radio-button>
                </a-radio-group>
            </div>

            <a-form layout="vertical" v-if="authMeta.setupRequired">
                <a-form-item label="管理员账号">
                    <a-input v-model:value="setupForm.username" placeholder="请输入管理员账号（至少3位）" size="large">
                        <template #prefix>
                            <UserOutlined style="color: rgba(0,0,0,.25)" />
                        </template>
                    </a-input>
                </a-form-item>

                <a-form-item label="管理员密码">
                    <a-input-password v-model:value="setupForm.password" placeholder="请输入密码（至少8位）" size="large">
                        <template #prefix>
                            <LockOutlined style="color: rgba(0,0,0,.25)" />
                        </template>
                    </a-input-password>
                </a-form-item>

                <a-form-item label="确认密码">
                    <a-input-password v-model:value="setupForm.confirmPassword" placeholder="请再次输入密码" size="large"
                        @pressEnter="handleSetup">
                        <template #prefix>
                            <LockOutlined style="color: rgba(0,0,0,.25)" />
                        </template>
                    </a-input-password>
                </a-form-item>

                <a-form-item label="API Token（可选）">
                    <a-input-password v-model:value="setupForm.authToken" placeholder="留空将自动生成安全 Token" size="large" />
                </a-form-item>

                <a-button type="primary" block size="large" :loading="loading" @click="handleSetup">
                    初始化并进入
                </a-button>
            </a-form>

            <a-form layout="vertical" v-else-if="loginMode === 'account'">
                <a-form-item label="管理员账号">
                    <a-input v-model:value="accountForm.username" placeholder="请输入管理员账号" size="large">
                        <template #prefix>
                            <UserOutlined style="color: rgba(0,0,0,.25)" />
                        </template>
                    </a-input>
                </a-form-item>

                <a-form-item label="管理员密码">
                    <a-input-password v-model:value="accountForm.password" placeholder="请输入管理员密码" size="large"
                        @pressEnter="handlePasswordLogin">
                        <template #prefix>
                            <LockOutlined style="color: rgba(0,0,0,.25)" />
                        </template>
                    </a-input-password>
                </a-form-item>

                <a-button type="primary" block size="large" :loading="loading" @click="handlePasswordLogin">
                    登录
                </a-button>
            </a-form>

            <a-form layout="vertical" v-else>
                <a-form-item label="API Token">
                    <a-input-password v-model:value="token" placeholder="请输入 API Token" size="large" @pressEnter="handleLogin">
                        <template #prefix>
                            <LockOutlined style="color: rgba(0,0,0,.25)" />
                        </template>
                    </a-input-password>
                </a-form-item>

                <a-button type="primary" block size="large" :loading="loading" @click="handleLogin">
                    验证并登录
                </a-button>
            </a-form>
        </div>
    </a-modal>
</template>
