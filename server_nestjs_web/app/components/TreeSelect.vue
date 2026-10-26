<script setup lang="ts">
const props = defineProps<{
  modelValue: number[]
  multiple?: boolean
  options: Array<any>
}>()
const emit = defineEmits(['update:modelValue'])

const flatOptions = computed(() => {
  const result: any[] = []

  function traverse(nodes: any[], level = 0) {
    for (const node of nodes) {
      const hasChild = node.children && node.children.length
      result.push({
        id: node.id,
        level,
        showIcon: hasChild,
        label: node.name
      })
      if (hasChild) {
        traverse(node.children, level + 1)
      }
    }
  }

  traverse(props.options)

  // console.log('result', result)
  return result
})

function onSelect(val: number) {
  emit('update:modelValue', val)
}
</script>

<template>
  <USelectMenu :model-value="modelValue" :search-input="false" variant="subtle" :multiple="multiple" :items="flatOptions" value-key="id" placeholder="请选择" class="w-full" @update:model-value="onSelect">
    <template #item="{ item }">
      <div class="flex items-center">
        <div class="w-4 h-4 mr-2" :style="{ 'margin-left': `${item.level * 15}px` }">
          <UIcon v-if="item.showIcon" name="i-lucide-chevron-down" />
        </div>
        <span>{{ item.name }}</span>
      </div>
    </template>
  </USelectMenu>
</template>
