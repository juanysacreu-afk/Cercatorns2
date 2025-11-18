import React from 'react';

interface ModalProps {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    children: React.ReactNode;
}

const Modal: React.FC<ModalProps> = ({ isOpen, onClose, title, children }) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-70 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        <div className="flex justify-between items-center p-4 border-b">
          <h3 className="text-xl font-ultrabold">{title}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-[#58595b] text-3xl">&times;</button>
        </div>
        <div className="p-6 overflow-y-auto space-y-4">
          {children}
        </div>
        <div className="p-4 border-t bg-gray-50 flex justify-end rounded-b-lg">
          <button onClick={onClose} className="bg-white text-[#58595b] font-ultrabold py-1 px-3 rounded-lg shadow-sm border-2 border-[#99cc33] transition-transform duration-200 hover:scale-[1.02] hover:bg-gray-50">
            Tancar
          </button>
        </div>
      </div>
    </div>
  );
};

export default Modal;