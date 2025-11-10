/**
 * WebGPU Game Engine - Part 5: Uniform Buffers & Animation
 * This script now handles:
 * 1. Vertex Buffers (from Part 4).
 * 2. Creating a Uniform Buffer (for global data like time/offsets).
 * 3. Creating a Bind Group (to link the uniform buffer to shaders).
 * 4. Updating the uniform buffer every frame.
 * 5. Creating a continuous "game loop" with requestAnimationFrame.
 */

// We'll store our core WebGPU objects in a simple state object
const gpu = {
    adapter: null,
    device: null,
    canvas: null,
    context: null,
    presentationFormat: null,
    renderPipeline: null,
    vertexBuffer: null,
    uniformBuffer: null, // NEW
    bindGroup: null,     // NEW
};

// We'll also store our data in a simple object
const data = {
    vertices: new Float32Array([
        // pos.x, pos.y,   color.r, color.g, color.b, color.a
           0.0,    0.5,    1.0, 0.0, 0.0, 1.0, // Vertex 1 (Top, Red)
          -0.5,   -0.5,    0.0, 1.0, 0.0, 1.0, // Vertex 2 (Bottom Left, Green)
           0.5,   -0.5,    0.0, 0.0, 1.0, 1.0, // Vertex 3 (Bottom Right, Blue)
    ]),
    // Our uniform data, just a 2D offset (x, y)
    // Needs 4 floats for 16-byte alignment (vec2f)
    uniforms: new Float32Array([
        0.0, 0.0, // Offset (vec2f)
        0.0, 0.0, // Padding
    ]),
};
const SIZEOF_UNIFORMS = data.uniforms.byteLength;


// Get the message element to show our status
const messageEl = document.getElementById('message');
if (!messageEl) {
    console.error("Failed to find #message element.");
}

/**
 * Initializes the WebGPU adapter, device, and pipeline.
 */
async function initializeWebGPU() {
    console.log("Initializing WebGPU...");
    
    if (!navigator.gpu) {
        throw new Error("WebGPU not supported on this browser.");
    }
    
    try {
        // 1. Request Adapter and Device
        gpu.adapter = await navigator.gpu.requestAdapter();
        if (!gpu.adapter) throw new Error("Failed to get GPU adapter.");
        
        gpu.device = await gpu.adapter.requestDevice();
        if (!gpu.device) throw new Error("Failed to get GPU device.");

        gpu.device.lost.then((info) => {
            console.error(`WebGPU device lost: ${info.message}`);
        });

        // 2. Get the Canvas and Context
        gpu.canvas = document.getElementById('game-canvas');
        if (!gpu.canvas) throw new Error("Failed to get canvas element.");
        
        const dpr = window.devicePixelRatio || 1;
        const observer = new ResizeObserver(entries => {
            for (const entry of entries) {
                if (entry.target === gpu.canvas) {
                    const { width, height } = entry.contentRect;
                    if (width > 0 && height > 0) {
                        gpu.canvas.width = Math.round(width * dpr);
                        gpu.canvas.height = Math.round(height * dpr);
                        // No render call needed here, game loop handles it
                    }
                }
            }
        });
        observer.observe(gpu.canvas);
        const { width, height } = gpu.canvas.getBoundingClientRect();
         if (width > 0 && height > 0) {
            gpu.canvas.width = Math.round(width * dpr);
            gpu.canvas.height = Math.round(height * dpr);
        }

        gpu.context = gpu.canvas.getContext('webgpu');
        if (!gpu.context) throw new Error("Failed to get WebGPU context from canvas.");

        // 3. Configure the Canvas Context
        gpu.presentationFormat = navigator.gpu.getPreferredCanvasFormat();
        
        gpu.context.configure({
            device: gpu.device,
            format: gpu.presentationFormat,
            alphaMode: 'premultiplied',
        });

        // 4. Create Vertex Buffer (from Part 4)
        gpu.vertexBuffer = gpu.device.createBuffer({
            size: data.vertices.byteLength,
            usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
        });
        gpu.device.queue.writeBuffer(gpu.vertexBuffer, 0, data.vertices);
        
        // --- NEW FOR PART 5 ---

        // 5. Create a Uniform Buffer
        gpu.uniformBuffer = gpu.device.createBuffer({
            size: SIZEOF_UNIFORMS,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        });
        // Write initial data
        gpu.device.queue.writeBuffer(gpu.uniformBuffer, 0, data.uniforms);

        // 6. Define Shaders (WGSL) - Now with uniforms!
        const shaderCode = `
            // This struct defines our uniform data
            struct Globals {
                offset: vec2<f32>,
            }
            
            // This struct defines data passed from VS to FS
            struct VertexOutput {
                @builtin(position) position: vec4<f32>,
                @location(0) color: vec4<f32>,
            }
            
            // Define our uniform buffer at group 0, binding 0
            @group(0) @binding(0)
            var<uniform> u_globals: Globals;

            @vertex
            fn vs_main(
                @location(0) in_position: vec2<f32>,
                @location(1) in_color: vec4<f32>
            ) -> VertexOutput {
                var out: VertexOutput;
                // Apply the uniform offset to the position
                out.position = vec4<f32>(in_position + u_globals.offset, 0.0, 1.0);
                out.color = in_color;
                return out;
            }

            @fragment
            fn fs_main(@location(0) in_color: vec4<f32>) -> @location(0) vec4<f32> {
                return in_color;
            }
        `;

        const shaderModule = gpu.device.createShaderModule({
            code: shaderCode,
        });

        // 7. Define the Vertex Buffer Layout (from Part 4)
        const vertexBufferLayout = {
            arrayStride: 6 * 4, // 24 bytes
            attributes: [
                { shaderLocation: 0, offset: 0, format: 'float32x2' }, // pos
                { shaderLocation: 1, offset: 2 * 4, format: 'float32x4' } // color
            ]
        };

        // 8. Create a Render Pipeline
        gpu.renderPipeline = gpu.device.createRenderPipeline({
            layout: 'auto', // 'auto' will infer bind group layout from shaders
            vertex: {
                module: shaderModule,
                entryPoint: 'vs_main',
                buffers: [vertexBufferLayout],
            },
            fragment: {
                module: shaderModule,
                entryPoint: 'fs_main',
                targets: [{ format: gpu.presentationFormat }],
            },
            primitive: {
                topology: 'triangle-list',
            },
        });
        
        // 9. Create a Bind Group
        // This links our actual buffer (gpu.uniformBuffer)
        // to the @group(0) @binding(0) variable in the shader.
        gpu.bindGroup = gpu.device.createBindGroup({
            // Get the layout that 'auto' inferred for group 0
            layout: gpu.renderPipeline.getBindGroupLayout(0), 
            entries: [
                {
                    binding: 0, // Corresponds to @binding(0)
                    resource: {
                        buffer: gpu.uniformBuffer,
                    },
                },
            ],
        });
        
        // -----------------------

        const successMsg = "WebGPU Initialized Successfully!";
        console.log(successMsg);
        if (messageEl) {
            messageEl.innerText = "WebGPU Ready! (Part 5)";
            messageEl.style.backgroundColor = 'rgba(0, 255, 100, 0.2)';
            setTimeout(() => messageEl.style.display = 'none', 2000);
        }
        
        return true;
        
    } catch (err) {
        const errorMsg = `WebGPU initialization failed: ${err.message}`;
        console.error(errorMsg, err);
        if (messageEl) messageEl.innerText = errorMsg;
        return false;
    }
}

/**
 * Our render function, now part of a game loop!
 */
function render() {
    if (!gpu.device || !gpu.context || !gpu.renderPipeline || !gpu.canvas || !gpu.vertexBuffer) {
        return;
    }
    if (gpu.canvas.width === 0 || gpu.canvas.height === 0) {
        console.warn("Canvas has zero size, skipping render.");
        return;
    }

    // --- NEW FOR PART 5 ---
    // Update our uniform data
    const time = performance.now() / 1000; // time in seconds
    data.uniforms[0] = Math.sin(time) * 0.3; // Update x offset
    data.uniforms[1] = Math.cos(time) * 0.3; // Update y offset
    
    // Write the new data to the uniform buffer
    gpu.device.queue.writeBuffer(
        gpu.uniformBuffer,
        0, // offset
        data.uniforms
    );
    // -----------------------


    const commandEncoder = gpu.device.createCommandEncoder();
    const textureView = gpu.context.getCurrentTexture().createView();

    const renderPassDescriptor = {
        colorAttachments: [
            {
                view: textureView,
                clearValue: { r: 0.1, g: 0.1, b: 0.2, a: 1.0 }, // Dark blue
                loadOp: 'clear',
                storeOp: 'store',
            },
        ],
    };

    const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
    
    // 4. Set pipeline, vertex buffer, and...
    passEncoder.setPipeline(gpu.renderPipeline);
    passEncoder.setVertexBuffer(0, gpu.vertexBuffer);
    
    // 5. ...SET THE BIND GROUP!
    // This tells the GPU to use the buffers we defined in gpu.bindGroup
    passEncoder.setBindGroup(0, gpu.bindGroup);

    // 6. Draw
    passEncoder.draw(3, 1, 0, 0);

    passEncoder.end();
    const commandBuffer = commandEncoder.finish();
    gpu.device.queue.submit([commandBuffer]);
}

/**
 * Starts the continuous game loop.
 */
function runGameLoop() {
    render(); // Render this frame
    requestAnimationFrame(runGameLoop); // Request the next frame
}

// Start the initialization process
(async () => {
    const success = await initializeWebGPU();
    if (success) {
        console.log("WebGPU State:", gpu);
        
        // Start the continuous render loop!
        runGameLoop();
        
    } else {
        console.log("WebGPU setup failed. See console for errors.");
    }
})();