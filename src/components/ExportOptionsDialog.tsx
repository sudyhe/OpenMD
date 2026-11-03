import { useTranslation } from "react-i18next";
import { Button, Dialog, HStack, Portal, SegmentGroup, Switch, Text, VStack } from "@chakra-ui/react";
import { useExportFlow } from "../stores/exportFlow";
import { useSettings, type ExportHeadingLevel } from "../stores/settings";
import { useOverlayBlur } from "../lib/overlayBlur";

/**
 * 「导出 PDF」选项对话框:点导出按钮 / Ctrl+P 先弹这里,确认后再走存盘对话框。
 * 三个选项直接写进 settings(持久化),下次导出记住上次的选择。
 *
 * Switch 必须带 <Switch.HiddenInput/>(ark-ui 的原生 checkbox 在 label 内,
 * 缺了它点击 label 不会触发切换);SegmentGroup 同理需要 ItemHiddenInput。
 */
export function ExportOptionsDialog() {
  const { t } = useTranslation();
  const open = useExportFlow((s) => s.open);
  const settle = useExportFlow((s) => s.settleExport);
  const exportOptions = useSettings((s) => s.exportOptions);
  const setExportOptions = useSettings((s) => s.setExportOptions);
  // 打开时模糊整个 App 内容(见 lib/overlayBlur.ts)。
  useOverlayBlur(open);

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(e) => {
        if (!e.open) settle(false);
      }}
      placement="center"
      size="sm"
    >
      <Portal>
        <Dialog.Backdrop bg="blackAlpha.300" />
        <Dialog.Positioner>
          <Dialog.Content
            borderRadius="12px"
            borderWidth="1px"
            borderColor="border.subtle"
            bg="bg"
            p={6}
            w="min(420px, 90vw)"
          >
            <VStack gap={4} align="stretch">
              <Dialog.Title fontSize="md">{t("viewer.export.optionsTitle")}</Dialog.Title>
              <Dialog.Body p={0}>
                <VStack gap={4} align="stretch">
                  <Switch.Root
                    size="sm"
                    checked={exportOptions.pageNumbers}
                    onCheckedChange={(d) => setExportOptions({ pageNumbers: d.checked })}
                  >
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                    <Switch.Label fontSize="sm">{t("viewer.export.pageNumbers")}</Switch.Label>
                    <Switch.HiddenInput />
                  </Switch.Root>

                  <VStack gap={1.5} align="stretch">
                    <Text fontSize="sm" color="fg.muted">
                      {t("viewer.export.headings")}
                    </Text>
                    <SegmentGroup.Root
                      size="sm"
                      value={exportOptions.headingLevel}
                      onValueChange={(e) =>
                        setExportOptions({ headingLevel: e.value as ExportHeadingLevel })
                      }
                      aria-label={t("viewer.export.headings")}
                    >
                      <SegmentGroup.Indicator />
                      <SegmentGroup.Item value="all">
                        <SegmentGroup.ItemHiddenInput />
                        <SegmentGroup.ItemText>{t("viewer.export.headingAll")}</SegmentGroup.ItemText>
                      </SegmentGroup.Item>
                      <SegmentGroup.Item value="no-h1">
                        <SegmentGroup.ItemHiddenInput />
                        <SegmentGroup.ItemText>
                          {t("viewer.export.headingNoH1")}
                        </SegmentGroup.ItemText>
                      </SegmentGroup.Item>
                      <SegmentGroup.Item value="no-h1-h2">
                        <SegmentGroup.ItemHiddenInput />
                        <SegmentGroup.ItemText>
                          {t("viewer.export.headingNoH1H2")}
                        </SegmentGroup.ItemText>
                      </SegmentGroup.Item>
                    </SegmentGroup.Root>
                  </VStack>

                  <Switch.Root
                    size="sm"
                    checked={exportOptions.includeFrontmatter}
                    onCheckedChange={(d) => setExportOptions({ includeFrontmatter: d.checked })}
                  >
                    <Switch.Control>
                      <Switch.Thumb />
                    </Switch.Control>
                    <Switch.Label fontSize="sm">{t("viewer.export.frontmatter")}</Switch.Label>
                    <Switch.HiddenInput />
                  </Switch.Root>
                </VStack>
              </Dialog.Body>
              <Dialog.Footer p={0} pt={1}>
                <HStack gap={2} w="100%" justify="flex-end">
                  <Button size="sm" variant="ghost" onClick={() => settle(false)}>
                    {t("misc.cancel")}
                  </Button>
                  <Button size="sm" variant="solid" colorPalette="gray" onClick={() => settle(true)}>
                    {t("viewer.export.proceed")}
                  </Button>
                </HStack>
              </Dialog.Footer>
            </VStack>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
