import { createApp } from 'vue'
import { createRouter, createWebHashHistory } from 'vue-router'
import App from './app.vue'
import './styles/main.css'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/halls' },
    { path: '/halls', component: () => import('./pages/hall_list_page.vue'), meta: { title: '展厅列表' } },
    { path: '/editor/:id', component: () => import('./pages/layout_editor_page.vue'), meta: { title: '布展编辑' } },
    { path: '/editor/:id/lights', component: () => import('./pages/light_setup_page.vue'), meta: { title: '灯光设置' } },
    { path: '/editor/:id/bake', component: () => import('./pages/bake_queue_page.vue'), meta: { title: '烘焙队列' } },
    { path: '/editor/:id/check', component: () => import('./pages/bake_check_page.vue'), meta: { title: '烘焙检查' } },
    { path: '/editor/:id/publish', component: () => import('./pages/publish_preview_page.vue'), meta: { title: '发布预览' } },
  ],
})

createApp(App).use(router).mount('#app')
