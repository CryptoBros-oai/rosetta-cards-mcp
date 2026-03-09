import os

def create_project_context(startpath):
    """
    Walks the directory structure and combines file contents into a single string
    formatted for LLM context ingestion.
    """
    # Directories and files to ignore
    exclude_dirs = {'.git', '__pycache__', '.idea', '.vscode', 'venv', 'node_modules', 'bin', 'obj'}
    exclude_extensions = {'.pyc', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.db', '.sqlite', '.exe', '.dll'}
    
    output = []
    
    # Add a directory tree view at the top
    output.append("PROJECT STRUCTURE:\n")
    for root, dirs, files in os.walk(startpath):
        dirs[:] = [d for d in dirs if d not in exclude_dirs]
        level = root.replace(startpath, '').count(os.sep)
        indent = ' ' * 4 * (level)
        output.append(f"{indent}{os.path.basename(root)}/")
        subindent = ' ' * 4 * (level + 1)
        for f in files:
            if not any(f.endswith(ext) for ext in exclude_extensions):
                output.append(f"{subindent}{f}")
    output.append("\n\nFILE CONTENTS:\n")

    # Add file contents
    for root, dirs, files in os.walk(startpath):
        dirs[:] = [d for d in dirs if d not in exclude_dirs]
        
        for file in files:
            if any(file.endswith(ext) for ext in exclude_extensions):
                continue
                
            path = os.path.join(root, file)
            relative_path = os.path.relpath(path, startpath)
            
            output.append(f"\n{'='*20}\nFILE: {relative_path}\n{'='*20}\n")
            
            try:
                with open(path, 'r', encoding='utf-8', errors='ignore') as f:
                    output.append(f.read())
            except Exception as e:
                output.append(f"[Error reading file: {e}]")
            
    return "\n".join(output)

if __name__ == "__main__":
    # Run this in your project root
    print(create_project_context("."))
