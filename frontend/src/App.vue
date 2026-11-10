<script setup lang="ts">
import { onLaunch } from '@dcloudio/uni-app';
import { initCloudEnv } from '@/utils/request';

onLaunch(() => {
  initCloudEnv();
});
</script>

<style lang="scss">
page {
  background-color: #f4f7fc;
  color: #182235;
  font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Helvetica Neue', 'Microsoft YaHei', sans-serif;
  box-sizing: border-box;
}

view,
text,
scroll-view,
input,
button,
textarea {
  box-sizing: border-box;
}

button::after {
  border: none;
}

.tu-primary-btn {
  width: 100%;
  height: 92rpx;
  line-height: 92rpx;
  border-radius: 46rpx;
  background: linear-gradient(135deg, #2b6ef6 0%, #1d4ed8 100%);
  color: #ffffff;
  font-size: 30rpx;
  font-weight: 600;
  text-align: center;
  box-shadow: 0 10rpx 24rpx rgba(37, 99, 235, 0.28);
}

.tu-primary-btn[disabled] {
  opacity: 0.5;
  box-shadow: none;
}

.tu-secondary-btn {
  height: 72rpx;
  line-height: 72rpx;
  padding: 0 28rpx;
  border-radius: 36rpx;
  background: #edf3ff;
  color: #2563eb;
  font-size: 26rpx;
  font-weight: 600;
  text-align: center;
}
</style>
