package app

import (
	"testing"

	"yingce/backend/internal/model"
)

func TestProtocolRequestFromInputUsesConfiguredBase64ForOpenAIImage(t *testing.T) {
	request := protocolRequestFromInput(canvasGenerationInput{
		Mode: "image",
		Config: providerConfig{
			InterfaceType: string(model.ChannelInterfaceOpenAIImage),
			ImageParameters: map[string]any{
				"size": "1024x1024",
			},
		},
		ImageCapability: &ImageCapabilityConfig{
			ResponseFormat: ParameterSupport{Supported: true, Default: "b64_json"},
		},
	})

	if got := request.ProviderOptions[string(model.ChannelInterfaceOpenAIImage)]["response_format"]; got != "b64_json" {
		t.Fatalf("response_format = %#v, want b64_json", got)
	}
}

func TestProtocolRequestFromInputOmitsAutomaticOpenAIImageFormat(t *testing.T) {
	request := protocolRequestFromInput(canvasGenerationInput{
		Mode: "image",
		Config: providerConfig{
			InterfaceType:   string(model.ChannelInterfaceOpenAIImage),
			ImageParameters: map[string]any{"size": "1024x1024"},
		},
		ImageCapability: &ImageCapabilityConfig{
			ResponseFormat: ParameterSupport{Supported: true, Default: "auto"},
		},
	})

	if _, ok := request.ProviderOptions[string(model.ChannelInterfaceOpenAIImage)]["response_format"]; ok {
		t.Fatal("response_format should be omitted when the model default is auto")
	}
}

func TestProtocolRequestFromInputKeepsURLForUnsupportedOpenAIImageFormat(t *testing.T) {
	request := protocolRequestFromInput(canvasGenerationInput{
		Mode:   "image",
		Config: providerConfig{InterfaceType: string(model.ChannelInterfaceOpenAIImage)},
		ImageCapability: &ImageCapabilityConfig{
			ResponseFormat: ParameterSupport{Supported: false},
		},
	})

	if _, ok := request.ProviderOptions[string(model.ChannelInterfaceOpenAIImage)]["response_format"]; ok {
		t.Fatal("response_format should be omitted when the capability is unsupported")
	}
}

func TestOpenAIVideoPixelSizeUsesGatewayEnumeratedSizes(t *testing.T) {
	tests := map[string]string{
		"16:9":      "1280x720",
		"9:16":      "720x1280",
		"4:3":       "1280x720",
		"3:4":       "720x1280",
		"1:1":       "1280x720",
		"21:9":      "1280x720",
		"auto":      "1280x720",
		"":          "1280x720",
		"1280x720":  "1280x720",
		"720x1280":  "720x1280",
		"1920x1080": "1280x720",
		"1080x1920": "720x1280",
	}
	for input, want := range tests {
		t.Run(input, func(t *testing.T) {
			if got := openAIVideoPixelSize(input); got != want {
				t.Fatalf("openAIVideoPixelSize(%q) = %q, want %q", input, got, want)
			}
		})
	}
}

func TestProtocolRequestFromInputConvertsNewAPIVideoRatioToPixels(t *testing.T) {
	request := protocolRequestFromInput(canvasGenerationInput{
		Mode: "video",
		Config: providerConfig{
			InterfaceType: string(model.ChannelInterfaceNewAPIVideo),
			Size:          "16:9",
		},
	})
	if request.AspectRatio != "1280x720" {
		t.Fatalf("aspectRatio = %q, want 1280x720", request.AspectRatio)
	}
}
